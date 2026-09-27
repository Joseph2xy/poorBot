import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { AttachmentBuilder, ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { createCommandHandler, gamesCommand, resolveAlertChannel, type GameInteraction } from './bot.ts';

type Operations = NonNullable<Parameters<typeof createCommandHandler>[2]>;
const guildId = '123456789012345678';
const product = { id: 'elden', name: 'Elden Ring', platform: 'steam' as const,
  url: 'https://www.allkeyshop.com/blog/buy-elden-ring-cd-key-compare-prices/' };
const savedState = { current: 2381, reference: 2500, checkedAt: Date.UTC(2026, 8, 27, 17, 0) };
function operations(overrides: Partial<Operations> = {}): Operations {
  const unexpected = async (): Promise<never> => { assert.fail('Unexpected tracker operation'); };
  return { addGame: unexpected, listGames: unexpected, removeGame: unexpected, runCheck: unexpected, ...overrides };
}
function interaction(command: string, strings: Record<string, string> = {}, dryRun: boolean | null = null) {
  const replies: Parameters<GameInteraction['reply']>[0][] = [];
  const edits: Parameters<GameInteraction['editReply']>[0][] = [];
  const events: string[] = [];
  const fake: GameInteraction = {
    guildId,
    memberPermissions: { has: permission => { assert.equal(permission, PermissionFlagsBits.ManageGuild); return true; } },
    options: { getSubcommand: () => command, getString: name => strings[name] ?? null,
      getBoolean: name => { assert.equal(name, 'dry-run'); return dryRun; } },
    reply: async options => { replies.push(options); events.push('reply'); },
    deferReply: async options => { assert.equal(options.flags, MessageFlags.Ephemeral); events.push('defer'); },
    editReply: async options => { edits.push(options); events.push('edit'); },
  };
  return { fake, replies, edits, events };
}

test('/games declares the management permission and supported subcommands', () => {
  const definition = gamesCommand.toJSON();
  assert.equal(definition.name, 'games');
  assert.equal(definition.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.deepEqual(definition.options?.map(option => option.name), ['add', 'list', 'remove', 'check']);
});

test('wrong guild, DMs, and missing management permission never invoke tracker operations', async () => {
  const handle = createCommandHandler(guildId, new AbortController().signal, operations());
  for (const context of [
    { guildId: '987654321098765432' }, { guildId: null },
    { memberPermissions: null }, { memberPermissions: { has: () => false } },
  ]) {
    const input = interaction('add', { url: product.url });
    Object.assign(input.fake, context);
    await handle(input.fake);
    assert.deepEqual(input.events, ['reply']);
    assert.match(String(input.replies[0].content), /Manage Server/);
    assert.equal(input.replies[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(input.replies[0].allowedMentions, { parse: [] });
  }
});

test('add acknowledges privately before changing tracking and forwards all options', async () => {
  const input = interaction('add', { url: product.url, name: '@everyone Elden Ring', edition: 'Deluxe' });
  const handle = createCommandHandler(guildId, new AbortController().signal, operations({
    addGame: async (...args) => {
      assert.deepEqual(input.events, ['defer']);
      assert.deepEqual(args, [product.url, '@everyone Elden Ring', 'Deluxe']);
      input.events.push('add');
      return 'Following @everyone Elden Ring';
    },
  }));
  await handle(input.fake);
  assert.deepEqual(input.events, ['defer', 'add', 'edit']);
  assert.equal(input.edits[0].content, 'Following @everyone Elden Ring');
  assert.deepEqual(input.edits[0].allowedMentions, { parse: [] });
});

test('add forwards omitted optional name and edition as undefined', async () => {
  const input = interaction('add', { url: product.url });
  await createCommandHandler(guildId, new AbortController().signal, operations({ addGame: async (...args) => {
    assert.deepEqual(args, [product.url, undefined, undefined]); return 'Added';
  } }))(input.fake);
  assert.equal(input.edits[0].content, 'Added');
});

test('list returns IDs and editions, handles empty lists, and attaches oversized results', async () => {
  for (const games of [[], [product], Array.from({ length: 30 }, (_, index) => ({ ...product, id: `game-${index}`, edition: 'Deluxe', state: savedState }))]) {
    const input = interaction('list');
    await createCommandHandler(guildId, new AbortController().signal, operations({ listGames: async () => games }))(input.fake);
    const reply = input.edits[0];
    if (!games.length) assert.match(String(reply.content), /No games followed/);
    else if (games.length === 1) assert.equal(reply.content, `${product.name} (Standard)\nID: elden\nAwaiting first successful check.\n${product.url}`);
    else {
      assert.equal(reply.content, 'Full results are attached.');
      const file = reply.files?.[0];
      assert.ok(file instanceof AttachmentBuilder);
      assert.equal(file.name, 'games.txt');
      assert.ok(Buffer.isBuffer(file.attachment));
      const contents = file.attachment.toString('utf8');
      assert.ok(contents.length > 2000);
      assert.match(contents, /Elden Ring \(Deluxe\)/);
      assert.match(contents, /ID: game-29/);
      assert.equal(contents.match(/Latest saved price: €23\.81/g)?.length, 30);
      assert.equal(contents.match(/Alert reference price: €25\.00/g)?.length, 30);
      assert.equal(contents.match(/Last successful check: Sun, 27 Sep 2026 17:00:00 GMT/g)?.length, 30);
    }
    assert.deepEqual(reply.allowedMentions, { parse: [] });
  }
});

test('list displays each saved price and check time without inventing an edition for WoW', async () => {
  const wowUrl = 'https://www.allkeyshop.com/blog/prepaids/buy-world-of-warcraft-subscription-60-day-france-compare-prices/i-co/';
  const input = interaction('list');
  await createCommandHandler(guildId, new AbortController().signal, operations({ listGames: async () => [
    { ...product, state: savedState },
    { ...product, id: 'wow', name: 'WoW 60 days', platform: 'battlenet', url: wowUrl,
      state: { current: 2400, reference: 2400, checkedAt: Date.UTC(2026, 8, 26, 16, 30) } },
  ] }))(input.fake);
  assert.equal(input.edits[0].content,
    'Elden Ring (Standard)\nID: elden\nLatest saved price: €23.81\nAlert reference price: €25.00\n'
    + `Last successful check: Sun, 27 Sep 2026 17:00:00 GMT\n${product.url}\n\n`
    + 'WoW 60 days\nID: wow\nLatest saved price: €24.00\nAlert reference price: €24.00\n'
    + `Last successful check: Sat, 26 Sep 2026 16:30:00 GMT\n${wowUrl}`);
  assert.deepEqual(input.events, ['defer', 'edit']);
});

test('remove acknowledges before forwarding the selected ID', async () => {
  const input = interaction('remove', { id: product.id });
  await createCommandHandler(guildId, new AbortController().signal, operations({ removeGame: async id => {
    assert.deepEqual(input.events, ['defer']); assert.equal(id, product.id); return 'Removed Elden Ring';
  } }))(input.fake);
  assert.equal(input.edits[0].content, 'Removed Elden Ring');
});

test('check forwards dry-run and shutdown signal and includes logs and failures', async () => {
  for (const dryRun of [true, false, null]) {
    const input = interaction('check', {}, dryRun);
    const signal = new AbortController().signal;
    await createCommandHandler(guildId, signal, operations({ runCheck: async options => {
      assert.deepEqual(input.events, ['defer']);
      assert.equal(options?.dryRun, dryRun ?? false);
      assert.equal(options?.signal, signal);
      options?.log?.('Elden Ring: €20.00');
      options?.log?.('Another game: source unavailable');
      return { failures: 1 };
    } }))(input.fake);
    assert.equal(input.edits[0].content,
      `${dryRun ? 'Preview' : 'Check'} finished with 1 failure(s).\nElden Ring: €20.00\nAnother game: source unavailable`);
  }
});

test('overlapping mutations are refused and operation failure releases the busy guard', async () => {
  let rejectPending!: (error: Error) => void;
  const pending = new Promise<string>((_, reject) => { rejectPending = reject; });
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  let calls = 0;
  const handle = createCommandHandler(guildId, new AbortController().signal, operations({ addGame: async () => {
    calls++;
    if (calls === 1) { notifyStarted(); return pending; }
    return 'Added successfully';
  } }));
  const first = interaction('add', { url: product.url });
  const running = handle(first.fake);
  await started;
  const duplicate = interaction('add', { url: product.url });
  await handle(duplicate.fake);
  assert.deepEqual(duplicate.events, ['reply']);
  assert.match(String(duplicate.replies[0].content), /still running/);
  assert.equal(calls, 1);
  rejectPending(new Error('disk full'));
  await running;
  assert.match(String(first.edits[0].content), /Could not complete the command: disk full/);
  const retry = interaction('add', { url: product.url });
  await handle(retry.fake);
  assert.equal(calls, 2);
  assert.equal(retry.edits[0].content, 'Added successfully');
});

test('list remains available during a check and cannot release its busy guard, even on failure', async () => {
  for (const outcome of ['success', 'operation failure', 'defer failure', 'reply failure']) {
    let finishCheck!: () => void;
    const pending = new Promise<void>(resolve => { finishCheck = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const handle = createCommandHandler(guildId, new AbortController().signal, operations({
      runCheck: async () => { notifyStarted(); await pending; return { failures: 0 }; },
      listGames: async () => {
        if (outcome === 'operation failure') throw new Error('List unavailable');
        return [product];
      },
      removeGame: async () => 'Removed',
    }));
    const checking = handle(interaction('check').fake);
    await started;
    try {
      const listing = interaction('list');
      if (outcome === 'defer failure') listing.fake.deferReply = async () => { throw new Error('Discord unavailable'); };
      if (outcome === 'reply failure') listing.fake.editReply = async () => { throw new Error('Discord unavailable'); };
      if (outcome === 'defer failure' || outcome === 'reply failure') {
        await assert.rejects(handle(listing.fake), /Discord unavailable/);
      } else {
        await handle(listing.fake);
        assert.deepEqual(listing.events, ['defer', 'edit']);
        assert.match(String(listing.edits[0].content), outcome === 'success' ? /Elden Ring/ : /List unavailable/);
      }
      for (const command of ['add', 'remove', 'check']) {
        const refused = interaction(command);
        await handle(refused.fake);
        assert.deepEqual(refused.events, ['reply']);
        assert.match(String(refused.replies[0].content), /still running/);
      }
    } finally { finishCheck(); await checking; }
    const removal = interaction('remove', { id: product.id });
    await handle(removal.fake);
    assert.equal(removal.edits[0].content, 'Removed');
  }
});

test('a pending list reply does not block a mutation', async () => {
  let finishReply!: () => void;
  const pending = new Promise<void>(resolve => { finishReply = resolve; });
  let notifyReply!: () => void;
  const replying = new Promise<void>(resolve => { notifyReply = resolve; });
  const handle = createCommandHandler(guildId, new AbortController().signal, operations({
    listGames: async () => [product], removeGame: async () => 'Removed',
  }));
  const listing = interaction('list');
  listing.fake.editReply = async () => { notifyReply(); await pending; };
  const running = handle(listing.fake);
  await replying;
  try {
    const removal = interaction('remove', { id: product.id });
    await handle(removal.fake);
    assert.equal(removal.edits[0].content, 'Removed');
  } finally { finishReply(); await running; }
});

test('failed acknowledgement has no side effect and does not block the next command', async () => {
  let calls = 0;
  const handle = createCommandHandler(guildId, new AbortController().signal, operations({ removeGame: async () => {
    calls++; return 'Removed';
  } }));
  const failed = interaction('remove', { id: product.id });
  failed.fake.deferReply = async () => { throw new Error('Discord unavailable'); };
  await assert.rejects(handle(failed.fake), /Discord unavailable/);
  assert.equal(calls, 0);
  assert.equal(failed.edits.length, 0);
  await handle(interaction('remove', { id: product.id }).fake);
  assert.equal(calls, 1);
});

test('shutdown refuses new commands without invoking tracker operations', async () => {
  const shutdown = new AbortController();
  const handle = createCommandHandler(guildId, shutdown.signal, operations());
  shutdown.abort();
  const input = interaction('check');
  await handle(input.fake);
  assert.deepEqual(input.events, ['reply']);
  assert.match(String(input.replies[0].content), /stopping/);
  assert.equal(input.replies[0].flags, MessageFlags.Ephemeral);
});

test('check interrupted by shutdown reports completed results without claiming completion', async () => {
  const shutdown = new AbortController();
  const input = interaction('check');
  await createCommandHandler(guildId, shutdown.signal, operations({ runCheck: async options => {
    options?.log?.('Elden Ring: baseline recorded');
    shutdown.abort();
    return { failures: 0 };
  } }))(input.fake);
  assert.match(String(input.edits[0].content), /Check stopped during shutdown/);
  assert.match(String(input.edits[0].content), /Elden Ring: baseline recorded/);
  assert.doesNotMatch(String(input.edits[0].content), /Check finished/);
});

const channelId = '234567890123456789';
const requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function channelClient(channel: unknown): Client<true> {
  return { channels: { fetch: async (id: string) => { assert.equal(id, channelId); return channel; } } } as unknown as Client<true>;
}

test('alert destination accepts server text and announcement channels with all send permissions', async () => {
  for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
    const member = { id: 'bot-member' };
    const channel = { type, guild: { members: { fetchMe: async () => member } },
      permissionsFor: (requested: unknown) => {
        assert.equal(requested, member);
        return new PermissionsBitField(requiredPermissions);
      } };
    assert.equal(await resolveAlertChannel(channelClient(channel), channelId), channel);
  }
});

test('alert destination rejects missing channels, DMs, threads, voice, and forum channels', async () => {
  for (const channel of [null, ...[ChannelType.DM, ChannelType.PublicThread, ChannelType.GuildVoice, ChannelType.GuildForum]
    .map(type => ({ type }))]) {
    await assert.rejects(resolveAlertChannel(channelClient(channel), channelId), /server text or announcement channel/);
  }
});

test('alert destination requires each viewing, sending, and embed permission', async () => {
  for (const missing of requiredPermissions) {
    const channel = { type: ChannelType.GuildText, guild: { members: { fetchMe: async () => ({}) } },
      permissionsFor: () => new PermissionsBitField(requiredPermissions.filter(permission => permission !== missing)) };
    await assert.rejects(resolveAlertChannel(channelClient(channel), channelId), /View Channel, Send Messages, and Embed Links/);
  }
});

test('failed bot login releases the lifetime tracker lock and shutdown listeners', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'price-bot-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('price-bot-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const script = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { resolve } from 'node:path';
    import { Client } from 'discord.js';
    import { main } from ${JSON.stringify(new URL('./bot.ts', import.meta.url).href)};
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    let loginCalled = false;
    let destroyed = false;
    Client.prototype.login = async function () {
      loginCalled = true;
      assert.equal(await readFile(resolve(process.env.TRACKER_DATA_DIR, '.tracker.lock'), 'utf8'), String(process.pid));
      throw new Error('fake login failure');
    };
    Client.prototype.destroy = async function () { destroyed = true; };
    await assert.rejects(main(), /Could not connect to Discord/);
    assert.equal(loginCalled, true);
    assert.equal(destroyed, true);
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5000,
    env: { ...process.env, TRACKER_DATA_DIR: directory, DISCORD_BOT_TOKEN: 'test-token', DISCORD_CHANNEL_ID: channelId },
  });
  await assert.rejects(readFile(resolve(directory, '.tracker.lock')), { code: 'ENOENT' });
});
