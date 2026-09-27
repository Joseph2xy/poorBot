import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchOffer, normalizeProductUrl, type Offer, type Product } from './sources.ts';
import { evaluate, type Decision, type PriceState, type PricingPolicy } from './pricing.ts';

interface TrackedGame extends Product { id: string; state?: PriceState; }
interface TrackerData { version: 1; settings: PricingPolicy; games: TrackedGame[]; }
interface CheckOptions { dryRun?: boolean; signal?: AbortSignal; log?: (text: string) => void; }
export interface Tracker {
  listGames(): Promise<TrackedGame[]>;
  addGame(url: string, name?: string, edition?: string): Promise<string>;
  removeGame(id: string): Promise<string>;
  runCheck(options?: CheckOptions): Promise<{ failures: number }>;
  watchPrices(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
interface TrackerOptions {
  directory: string;
  send: (offer: Offer, decision: Decision) => Promise<void>;
  getOffer?: (product: Product) => Promise<Offer>;
  log?: (text: string) => void;
  onFatal?: (error: Error) => void;
}

const defaults: PricingPolicy = { minimumDropPercent: 10, minimumDropEuro: 2, checkIntervalMinutes: 60, resetAfterHours: 48 };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPrice = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const euro = (price: number) => `€${(price / 100).toFixed(2)}`;
const editionKey = (edition?: string) => (edition || 'Standard').trim().toLowerCase();
const identity = (game: Product) => JSON.stringify([normalizeProductUrl(game.url), game.platform, editionKey(game.edition)]);

export function validateData(value: unknown): TrackerData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.settings) || !Array.isArray(value.games)) {
    throw new Error('Invalid tracker.json. Restore a backup before restarting.');
  }
  const settings = value.settings;
  if (!isNumber(settings.minimumDropPercent) || settings.minimumDropPercent < 0 || settings.minimumDropPercent > 100
    || !isNumber(settings.minimumDropEuro) || settings.minimumDropEuro < 0 || settings.minimumDropEuro > Number.MAX_SAFE_INTEGER / 100
    || !isNumber(settings.checkIntervalMinutes) || settings.checkIntervalMinutes < 1 || settings.checkIntervalMinutes > Math.floor(2_147_483_647 / 60_000)
    || !isNumber(settings.resetAfterHours) || settings.resetAfterHours < 1 || settings.resetAfterHours > Number.MAX_SAFE_INTEGER / 3_600_000) {
    throw new Error('Invalid price settings in tracker.json.');
  }
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const game of value.games as unknown[]) {
    if (!isRecord(game) || typeof game.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(game.id) || ids.has(game.id)
      || typeof game.name !== 'string' || !game.name.trim() || typeof game.url !== 'string'
      || (game.platform !== 'steam' && game.platform !== 'battlenet')
      || (game.edition !== undefined && (typeof game.edition !== 'string' || !game.edition.trim()))) {
      throw new Error('Invalid or duplicate product in tracker.json.');
    }
    const product = game as unknown as TrackedGame;
    if (product.platform === 'battlenet' && editionKey(product.edition) !== 'standard') throw new Error('Edition selection is only supported for Steam games.');
    const key = identity(product);
    if (identities.has(key)) throw new Error('Duplicate product edition in tracker.json.');
    ids.add(game.id); identities.add(key);
    const state = game.state;
    if (state !== undefined && (!isRecord(state) || !isPrice(state.reference) || !isPrice(state.current) || !isPrice(state.checkedAt)
      || (state.higherSince !== undefined && (!isPrice(state.higherSince) || state.higherSince > state.checkedAt || !isPrice(state.recoveryFloor)))
      || (state.recoveryFloor !== undefined && state.higherSince === undefined))) throw new Error('Invalid saved price in tracker.json.');
  }
  return value as unknown as TrackerData;
}

export async function openTracker({ directory, send, getOffer = fetchOffer, log = console.log, onFatal }: TrackerOptions): Promise<Tracker> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const path = resolve(root, 'tracker.json');
  const lockPath = resolve(root, '.tracker.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    throw new Error(`Tracker lock already exists: ${lockPath}. Another tracker may be running. If a run was interrupted, stop all tracker processes, delete this lock file, then restart.`);
  }
  const release = async () => { try { await lock.close(); } finally { await unlink(lockPath); } };
  const save = async (value: TrackerData) => {
    const temp = `${path}.${process.pid}.tmp`;
    try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n'); await rename(temp, path); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
  };
  let data: TrackerData;
  try {
    await lock.writeFile(String(process.pid));
    let contents;
    try { contents = await readFile(path, 'utf8'); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    if (contents === undefined) {
      data = { version: 1, settings: { ...defaults }, games: [] };
      await save(data);
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(contents); }
      catch { throw new Error('Invalid JSON in tracker.json; the file was not changed.'); }
      data = validateData(parsed);
    }
  } catch (error) { await release(); throw error; }

  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let fatal: Error | undefined;
  const healthy = () => { if (fatal) throw fatal; };
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('Tracker is closing.'));
    const result = tail.then(() => { healthy(); return action(); });
    tail = result.catch(() => {});
    return result;
  };
  const commit = async (updated: TrackerData) => {
    try { await save(updated); }
    catch (error) {
      fatal = new Error(`Tracker storage failed; restart after fixing the problem: ${errorMessage(error)}`);
      try { onFatal?.(fatal); } catch { /* Preserve the storage failure. */ }
      throw fatal;
    }
    data = updated;
  };

  const tracker: Tracker = {
    async listGames() {
      healthy();
      if (closing) throw new Error('Tracker is closing.');
      return structuredClone(data.games);
    },
    async addGame(inputUrl, inputName, inputEdition) {
      const url = normalizeProductUrl(inputUrl);
      if (inputName !== undefined && (typeof inputName !== 'string' || !inputName.trim())) throw new Error('Product name cannot be empty.');
      if (inputEdition !== undefined && (typeof inputEdition !== 'string' || !inputEdition.trim())) throw new Error('Edition cannot be empty.');
      const edition = inputEdition?.trim() || 'Standard';
      const prepaid = new URL(url).pathname.includes('/prepaids/');
      const platform = prepaid ? 'battlenet' : 'steam';
      if (prepaid && !/world-of-warcraft.*(?:subscription|time|day)/i.test(url)) {
        throw new Error('Prepaid tracking currently supports WoW game time on Battle.net only.');
      }
      if (platform === 'battlenet' && editionKey(edition) !== 'standard') throw new Error('Edition selection is only supported for Steam games.');
      const slug = new URL(url).pathname.split('/').find(part => part.endsWith('compare-prices'))!;
      const name = inputName?.trim() || slug.replace(/^buy-/, '').replace(/-(?:cd-key-|key-)?compare-prices$/, '').replaceAll('-', ' ');
      const id = createHash('sha256').update(editionKey(edition) === 'standard' ? url : identity({ url, name, platform, edition })).digest('hex').slice(0, 12);
      const game: TrackedGame = { id, name, url, platform, ...(editionKey(edition) === 'standard' ? {} : { edition }) };
      return enqueue(async () => {
        if (data.games.some(existing => identity(existing) === identity(game))) return 'Already following this product.';
        await commit(validateData({ ...data, games: [...data.games, game] }));
        return `Following ${name} (${id}). The first successful price check records the baseline for future alerts.`;
      });
    },
    async removeGame(id) {
      return enqueue(async () => {
        const found = data.games.find(game => game.id === id);
        if (!found) throw new Error('Unknown product id. List followed products to find the correct ID.');
        await commit({ ...data, games: data.games.filter(game => game.id !== id) });
        return `Removed ${found.name}.`;
      });
    },
    runCheck({ dryRun = false, signal, log: report = log } = {}) {
      return enqueue(async () => {
        let failures = 0;
        if (!data.games.length) report('No products followed. Add a product to start tracking prices.');
        for (const game of data.games) {
          if (signal?.aborted) break;
          const label = game.platform === 'steam' ? `${game.name} (${game.edition || 'Standard'})` : game.name;
          let offer: Offer, decision: Decision;
          try {
            offer = await getOffer(structuredClone(game));
            decision = evaluate(game.state, offer.price, data.settings);
            if (decision.alert && !dryRun) await send(offer, decision);
          } catch (error) {
            report(`${label}: ${errorMessage(error)} Previous state kept.`);
            failures++;
            continue;
          }
          if (!dryRun) await commit({ ...data, games: data.games.map(existing => existing.id === game.id ? { ...game, state: decision.next } : existing) });
          report(`${label}: ${euro(offer.price)} at ${offer.merchant}${offer.coupon ? ` (coupon ${offer.coupon})` : ''} — ${decision.reason}${dryRun ? ' [preview: nothing saved or sent]' : ''}`);
        }
        return { failures };
      });
    },
    async watchPrices(signal) {
      while (!signal.aborted) {
        log(`Checking prices at ${new Date().toISOString()}`);
        await tracker.runCheck({ signal });
        if (signal.aborted) break;
        try { await sleep(data.settings.checkIntervalMinutes * 60_000, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    },
    close() { closing ??= tail.then(release); return closing; },
  };
  return tracker;
}
