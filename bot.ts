import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type InteractionReplyOptions, type InteractionEditReplyOptions, type TextChannel, type NewsChannel,
} from 'discord.js';
import { openTracker, type Tracker } from './tracker.ts';
import { priceAlert } from './notifications.ts';

const gamesCommand = new SlashCommandBuilder()
  .setName('games')
  .setDescription('Manage game price alerts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(command => command.setName('add').setDescription('Follow an AllKeyShop product')
    .addStringOption(option => option.setName('url').setDescription('English AllKeyShop comparison-page URL').setRequired(true).setMaxLength(500))
    .addStringOption(option => option.setName('name').setDescription('Display name for the game').setMaxLength(200))
    .addStringOption(option => option.setName('edition').setDescription('Steam edition, such as Standard or Deluxe').setMaxLength(100)))
  .addSubcommand(command => command.setName('list').setDescription('Show followed games, saved prices, and last successful checks'))
  .addSubcommand(command => command.setName('remove').setDescription('Stop following a game')
    .addStringOption(option => option.setName('id').setDescription('Product ID from /games list').setRequired(true).setMaxLength(100)))
  .addSubcommand(command => command.setName('check').setDescription('Check prices now, save baselines, and send qualifying alerts')
    .addBooleanOption(option => option.setName('dry-run').setDescription('Preview prices without saving or sending alerts')));

// This small interface keeps command behavior testable without connecting to Discord.
export interface GameInteraction {
  guildId: string | null;
  memberPermissions: { has(permission: bigint): boolean } | null;
  options: {
    getSubcommand(): string;
    getString(name: string, required?: boolean): string | null;
    getBoolean(name: string): boolean | null;
  };
  reply(options: InteractionReplyOptions): Promise<unknown>;
  deferReply(options: { flags: typeof MessageFlags.Ephemeral }): Promise<unknown>;
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
}

type GameOperations = Pick<Tracker, 'addGame' | 'listGames' | 'removeGame' | 'runCheck'>;
const noMentions = { parse: [] as never[] };

function replyText(text: string): InteractionEditReplyOptions {
  if (text.length <= 2000) return { content: text, allowedMentions: noMentions };
  return { content: 'Full results are attached.', allowedMentions: noMentions,
    files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: 'games.txt' })] };
}

export function createCommandHandler(guildId: string, signal: AbortSignal, operations: GameOperations) {
  let busy = false;
  return async (interaction: GameInteraction): Promise<void> => {
    const command = interaction.options.getSubcommand();
    const exclusive = command !== 'list';
    let refusal: string | undefined;
    if (interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      refusal = 'These commands are available to members with Manage Server permission in the configured server.';
    } else if (signal.aborted) refusal = 'The tracker is stopping. Try again after it restarts.';
    else if (busy && exclusive) refusal = 'Another game command is still running. Please wait for it to finish.';
    if (refusal) {
      await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
      return;
    }
    if (exclusive) busy = true;
    try {
      // Acknowledge before waiting for a scheduled check or any network request.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let result: string;
      try {
        switch (command) {
          case 'add':
            result = await operations.addGame(interaction.options.getString('url', true) ?? '',
              interaction.options.getString('name') ?? undefined, interaction.options.getString('edition') ?? undefined);
            break;
          case 'remove':
            result = await operations.removeGame(interaction.options.getString('id', true) ?? '');
            break;
          case 'list': {
            const games = await operations.listGames();
            result = games.length ? games.map(game => {
              const title = game.platform === 'steam' ? `${game.name} (${game.edition || 'Standard'})` : game.name;
              const status = game.state
                ? `Latest saved price: €${(game.state.current / 100).toFixed(2)}\nAlert reference price: €${(game.state.reference / 100).toFixed(2)}\nLast successful check: ${new Date(game.state.checkedAt).toUTCString()}`
                : 'Awaiting first successful check.';
              return `${title}\nID: ${game.id}\n${status}\n${game.url}`;
            }).join('\n\n')
              : 'No games followed yet. Use /games add to follow one.';
            break;
          }
          case 'check': {
            const lines: string[] = [];
            const dryRun = interaction.options.getBoolean('dry-run') ?? false;
            const { failures } = await operations.runCheck({ dryRun, signal, log: line => lines.push(line) });
            const summary = signal.aborted ? 'Check stopped during shutdown. Completed results below.'
              : `${dryRun ? 'Preview' : 'Check'} finished${failures ? ` with ${failures} failure(s)` : ''}.`;
            result = `${summary}\n${lines.join('\n')}`;
            break;
          }
          default: result = 'Use /games add, list, remove, or check.';
        }
      } catch (error) {
        // Tracker errors are safe, local validation/storage messages. Discord SDK
        // errors are handled separately below, without logging request tokens.
        result = `Could not complete the command: ${error instanceof Error ? error.message : 'unexpected tracker error'}`;
      }
      await interaction.editReply(replyText(result));
    } finally { if (exclusive) busy = false; }
  };
}

// Resolve the server from the alert channel: there is only one destination to configure.
export async function resolveAlertChannel(client: Client<true>, channelId: string): Promise<TextChannel | NewsChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    throw new Error('DISCORD_CHANNEL_ID must identify a server text or announcement channel.');
  }
  const member = await channel.guild.members.fetchMe();
  const permissions = channel.permissionsFor(member);
  if (!permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new Error('Allow the bot View Channel, Send Messages, and Embed Links in the alert channel.');
  }
  return channel;
}

export async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const channelId = process.env.DISCORD_CHANNEL_ID?.trim();
  if (!token) throw new Error('Set DISCORD_BOT_TOKEN in .env.');
  if (!channelId || !/^\d{17,20}$/.test(channelId)) throw new Error('Set DISCORD_CHANNEL_ID in .env to the channel for price alerts.');

  const shutdown = new AbortController();
  const client = new Client({ intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [], repliedUser: false }, rest: { timeout: 20_000, retries: 2 } });
  const active = new Set<Promise<void>>();
  let tracker: Tracker | undefined;
  let channel: TextChannel | NewsChannel;
  let fatalError: Error | undefined;
  const stop = () => {
    if (!shutdown.signal.aborted) console.log('Stopping after current operations finish…');
    shutdown.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  client.on(Events.Error, () => console.error('Discord connection error; the client will attempt to reconnect.'));
  client.on(Events.Invalidated, () => {
    fatalError = new Error('Discord session became invalid. Restart the bot.');
    stop();
  });

  try {
    tracker = await openTracker({
      directory: resolve(process.env.TRACKER_DATA_DIR || fileURLToPath(new URL('./', import.meta.url))),
      send: async (offer, decision) => {
        try { await channel.send(priceAlert(offer, decision)); }
        catch { throw new Error('Discord alert delivery failed; the previous baseline is kept for the next check.'); }
      },
      onFatal: error => { fatalError = error; stop(); },
    });
    const ready = once(client, Events.ClientReady, { signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]) });
    try { await Promise.all([client.login(token), ready]); }
    catch {
      if (fatalError) throw fatalError;
      if (shutdown.signal.aborted) return;
      throw new Error('Could not connect to Discord. Check DISCORD_BOT_TOKEN and your internet connection.');
    }
    if (shutdown.signal.aborted) {
      if (fatalError) throw fatalError;
      return;
    }
    try { channel = await resolveAlertChannel(client as Client<true>, channelId); }
    catch (error) {
      if (error instanceof Error && /^(Allow the bot|DISCORD_CHANNEL_ID)/.test(error.message)) throw error;
      throw new Error('Could not access the alert channel. Check its ID and invite the bot to that server.');
    }
    try {
      // Upsert only /games, preserving unrelated commands on this application.
      await client.application!.commands.create(gamesCommand, channel.guildId);
    } catch { throw new Error('Could not register /games. Invite the bot with bot and applications.commands scopes.'); }
    const handle = createCommandHandler(channel.guildId, shutdown.signal, tracker);
    console.log('Discord bot connected. /games commands are ready; alerts are sent by the bot.');
    client.on(Events.InteractionCreate, interaction => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'games') return;
      const task = handle(interaction).catch(() => console.error('Could not send a Discord command reply.'));
      active.add(task);
      void task.finally(() => active.delete(task));
    });
    await tracker.watchPrices(shutdown.signal);
    if (fatalError) throw fatalError;
  } finally {
    shutdown.abort();
    try {
      await Promise.allSettled(active);
      await tracker?.close();
    } finally {
      await client.destroy();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Bot stopped unexpectedly.');
    process.exitCode = 1;
  });
}
