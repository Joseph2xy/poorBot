import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { openTracker, validateData } from './tracker.ts';
import type { Offer } from './sources.ts';

const url = 'https://www.allkeyshop.com/blog/buy-elden-ring-cd-key-compare-prices/';
const secondUrl = 'https://www.allkeyshop.com/blog/buy-hades-cd-key-compare-prices/';
const wowUrl = 'https://www.allkeyshop.com/blog/prepaids/buy-world-of-warcraft-subscription-60-day-france-compare-prices/i-co/';
const offer = (price: number): Offer => ({ title: 'Elden Ring', url, price, merchant: 'Store' });
const log = () => {};

async function setup(t: TestContext, options: Partial<Parameters<typeof openTracker>[0]> = {}) {
  const directory = await fs.mkdtemp(resolve(tmpdir(), 'price-tracker-test-'));
  const tracker = await openTracker({ directory, log, send: async () => {}, getOffer: async () => offer(2500), ...options });
  t.after(async () => {
    await tracker.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('price-tracker-test-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const read = async () => validateData(JSON.parse(await fs.readFile(resolve(directory, 'tracker.json'), 'utf8')));
  return { tracker, directory, read };
}

test('new tracker initializes defaults, holds a lifetime lock, and releases it on close', async t => {
  const { tracker, directory, read } = await setup(t);
  assert.deepEqual(await tracker.listGames(), []);
  assert.equal((await read()).settings.minimumDropPercent, 10);
  assert.equal((await fs.readFile(resolve(directory, '.tracker.lock'), 'utf8')), String(process.pid));
  await assert.rejects(openTracker({ directory, send: async () => {} }), /Tracker lock already exists/);
  await tracker.close();
  await tracker.close();
  await assert.rejects(fs.readFile(resolve(directory, '.tracker.lock')), { code: 'ENOENT' });
  await assert.rejects(tracker.addGame(url), /closing/);
  const reopened = await openTracker({ directory, send: async () => {} });
  await reopened.close();
});

test('invalid stored data is preserved and failed startup releases its lock', async t => {
  const { tracker, directory } = await setup(t);
  await tracker.close();
  const path = resolve(directory, 'tracker.json');
  await fs.writeFile(path, '{broken');
  await assert.rejects(openTracker({ directory, send: async () => {} }), /Invalid JSON/);
  assert.equal(await fs.readFile(path, 'utf8'), '{broken');
  await assert.rejects(fs.readFile(resolve(directory, '.tracker.lock')), { code: 'ENOENT' });
});

test('validation rejects unsafe timers, malformed state, and duplicate identities', async t => {
  const { tracker, read } = await setup(t);
  await tracker.addGame(url);
  const data = await read();
  assert.throws(() => validateData({ ...data, settings: { ...data.settings, checkIntervalMinutes: 40000 } }), /settings/);
  for (const state of [
    { reference: -1, current: 100, checkedAt: 1 },
    { reference: 100, current: 100, checkedAt: 1, recoveryFloor: 100 },
    { reference: 100, current: 100, checkedAt: 1, higherSince: 2, recoveryFloor: 100 },
  ]) assert.throws(() => validateData({ ...data, games: [{ ...data.games[0], state }] }), /saved price/);
  assert.throws(() => validateData({ ...data, games: [data.games[0], { ...data.games[0], id: 'other', edition: ' STANDARD ' }] }), /Duplicate product edition/);
});

test('queued updates survive ordinary errors and distinguish Steam editions', async t => {
  const { tracker, read } = await setup(t, { getOffer: async () => assert.fail('Add fetched prices') });
  const results = await Promise.allSettled([
    tracker.removeGame('missing'), tracker.addGame(url), tracker.addGame(url, 'Deluxe game', ' Deluxe '),
    tracker.addGame(url, 'Duplicate', ' deluxe '), tracker.addGame(url, 'Standard duplicate', ' STANDARD '),
  ]);
  assert.equal(results[0].status, 'rejected');
  for (const result of results.slice(1)) assert.equal(result.status, 'fulfilled');
  const games = await tracker.listGames();
  assert.equal(games.length, 2);
  assert.equal(games[0].name, 'elden ring');
  assert.equal(games[1].edition, 'Deluxe');
  assert.notEqual(games[0].id, games[1].id);
  await assert.rejects(tracker.addGame(url, ' '), /name cannot be empty/);
  await assert.rejects(tracker.addGame(wowUrl, 'WoW', 'Deluxe'), /only supported for Steam/);
  games[0].name = 'Mutated snapshot';
  assert.equal((await tracker.listGames())[0].name, 'elden ring');
  await Promise.all(games.map(game => tracker.removeGame(game.id)));
  assert.deepEqual((await read()).games, []);
});

test('failed delivery preserves baseline and a successful retry alerts only once', async t => {
  let price = 2500, sends = 0, fail = true;
  const { tracker, read } = await setup(t, {
    getOffer: async () => offer(price),
    send: async () => { sends++; if (fail) throw new Error('offline'); },
  });
  await tracker.addGame(url);
  await tracker.runCheck();
  const before = await read();
  price = 2000;
  assert.equal((await tracker.runCheck()).failures, 1);
  assert.deepEqual(await read(), before);
  fail = false;
  await tracker.runCheck();
  await tracker.runCheck();
  assert.equal(sends, 2);
  assert.equal((await read()).games[0].state?.reference, 2000);
});

test('unsupported prepaid products are rejected on add without fetching or changing the store', async t => {
  const { tracker, read } = await setup(t, { getOffer: async () => assert.fail('Add fetched prices') });
  await tracker.addGame(wowUrl, 'WoW 60 days');
  const before = await read();
  assert.equal(before.games[0].platform, 'battlenet');
  await assert.rejects(tracker.addGame('https://www.allkeyshop.com/blog/prepaids/buy-xbox-game-pass-compare-prices/'),
    /supports WoW game time/);
  assert.deepEqual(await read(), before);
});

test('source failures preserve the affected game and allow other games to continue', async t => {
  let fail = false;
  const { tracker, read } = await setup(t, { getOffer: async game => {
    if (fail && game.url === url) throw new Error('Source blocked');
    return offer(2500);
  } });
  await tracker.addGame(url);
  await tracker.runCheck();
  const before = (await read()).games[0];
  await tracker.addGame(secondUrl);
  fail = true;
  assert.equal((await tracker.runCheck()).failures, 1);
  assert.deepEqual((await read()).games[0], before);
  assert.equal((await read()).games[1].state?.current, 2500);
});

test('preview preserves disk and memory and never sends a qualifying alert', async t => {
  let price = 2500;
  const { tracker, read } = await setup(t, { getOffer: async () => offer(price), send: async () => assert.fail('Preview sent') });
  await tracker.addGame(url);
  await tracker.runCheck();
  const before = await read();
  price = 2000;
  const lines: string[] = [];
  await tracker.runCheck({ dryRun: true, log: text => lines.push(text) });
  assert.deepEqual(await read(), before);
  assert.deepEqual(await tracker.listGames(), before.games);
  assert.match(lines[0], /meaningful drop.*nothing saved or sent/);
});

test('check results identify editions with identical names, including failures and previews', async t => {
  let failDeluxe = false;
  const { tracker } = await setup(t, { getOffer: async game => {
    if (failDeluxe && game.edition === 'Deluxe') throw new Error('No matching offer');
    return offer(2500);
  } });
  await tracker.addGame(url, 'Elden Ring');
  await tracker.addGame(url, 'Elden Ring', 'Deluxe');
  await tracker.addGame(wowUrl, 'WoW 60 days');
  const lines: string[] = [];
  await tracker.runCheck({ log: line => lines.push(line) });
  assert.match(lines[0], /^Elden Ring \(Standard\):/);
  assert.match(lines[1], /^Elden Ring \(Deluxe\):/);
  assert.match(lines[2], /^WoW 60 days:/);
  lines.length = 0;
  failDeluxe = true;
  await tracker.runCheck({ dryRun: true, log: line => lines.push(line) });
  assert.match(lines[0], /^Elden Ring \(Standard\):.*preview/);
  assert.match(lines[1], /^Elden Ring \(Deluxe\): No matching offer/);
});

test('shutdown during delivery saves the completed alert and skips remaining games', async t => {
  const shutdown = new AbortController();
  let price = 2500, sends = 0;
  const { tracker, read } = await setup(t, {
    getOffer: async () => offer(price), send: async () => { sends++; shutdown.abort(); },
  });
  await tracker.addGame(url);
  await tracker.addGame(secondUrl);
  await tracker.runCheck();
  price = 2000;
  await tracker.runCheck({ signal: shutdown.signal });
  const saved = await read();
  assert.equal(saved.games[0].state?.reference, 2000);
  assert.equal(saved.games[1].state?.reference, 2500);
  assert.equal(sends, 1);
});

test('close drains accepted work while lists remain responsive during an active check', async t => {
  let started!: () => void, finish!: () => void;
  const fetching = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { finish = resolve; });
  const { tracker, read, directory } = await setup(t, { getOffer: async () => { started(); await resume; return offer(2500); } });
  await tracker.addGame(url);
  const checking = tracker.runCheck();
  await fetching;
  const games = await tracker.listGames();
  assert.equal(games[0].state, undefined);
  const removing = tracker.removeGame(games[0].id);
  const closing = tracker.close();
  await assert.rejects(tracker.addGame(secondUrl), /closing/);
  assert.equal(await fs.readFile(resolve(directory, '.tracker.lock'), 'utf8'), String(process.pid));
  finish();
  await Promise.all([checking, removing, closing]);
  assert.deepEqual((await read()).games, []);
  await assert.rejects(fs.readFile(resolve(directory, '.tracker.lock')), { code: 'ENOENT' });
});

test('disk failure stops checks, poisons queued mutations, and keeps committed state intact', async t => {
  let price = 2500, sends = 0, fatalCalls = 0;
  const { tracker, read, directory } = await setup(t, {
    getOffer: async () => offer(price), send: async () => { sends++; }, onFatal: () => { fatalCalls++; },
  });
  await tracker.addGame(url);
  await tracker.addGame(secondUrl);
  await tracker.runCheck();
  const before = await read();
  const rename = fs.rename;
  fs.rename = async () => { throw new Error('Simulated disk full'); };
  syncBuiltinESMExports();
  price = 2000;
  try {
    const results = await Promise.allSettled([tracker.runCheck(), tracker.removeGame(before.games[0].id)]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(String(result.reason), /storage failed/);
    }
    await assert.rejects(tracker.runCheck(), /storage failed/);
    await assert.rejects(tracker.listGames(), /storage failed/);
    assert.equal(sends, 1);
    assert.equal(fatalCalls, 1);
  } finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.deepEqual(await read(), before);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.tracker.lock', 'tracker.json']);
  await tracker.close();
  const reopened = await openTracker({ directory, send: async () => {} });
  assert.deepEqual(await reopened.listGames(), before.games);
  await reopened.close();
});

test('sleeping watcher responds to shutdown without starting another check', async t => {
  const shutdown = new AbortController();
  let checks = 0;
  const { tracker } = await setup(t, { getOffer: async () => { checks++; return offer(2500); } });
  await tracker.addGame(url);
  const watching = tracker.watchPrices(shutdown.signal);
  await tracker.runCheck({ dryRun: true });
  shutdown.abort();
  await watching;
  assert.equal(checks, 2);
});
