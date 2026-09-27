# Game price alerts for Discord

A small Discord bot that follows AllKeyShop products, checks their lowest suitable advertised EUR prices, and posts meaningful price drops to one channel. Manage games with slash commands; the same bot runs the hourly checks and sends alerts.

## Setup

Requires **Node.js 24.12 or newer**. Run `npm ci` in this folder. TypeScript runs directly; there is no build step.

1. Copy `.env.example` to `.env` if it does not already exist.
2. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot → Reset Token**, obtain the bot token and put it after `DISCORD_BOT_TOKEN=` in `.env`. Keep it private. See [Discord's setup guide](https://github.com/discord/discord-api-docs/blob/main/developers/quick-start/getting-started.mdx).
3. Under **OAuth2 → URL Generator**, select `bot` and `applications.commands`. Select **View Channels**, **Send Messages**, and **Embed Links**, then open the generated link to invite the bot to your server. Administrator and privileged gateway intents are unnecessary. Ensure channel overrides also allow these permissions in the destination channel. See the [discord.js invitation guide](https://github.com/discordjs/guide/blob/main/guide/preparations/adding-your-bot-to-servers.md).
4. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click the text channel for alerts and choose **Copy Channel ID**. Put that value after `DISCORD_CHANNEL_ID=` in `.env`. The bot derives the server from this channel; no separate server ID or webhook is needed. See [Discord's ID instructions](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID).
5. Run `npm start`. Wait for `/games commands are ready`. The bot starts checking immediately, then waits the configured interval between checks.

Run **one bot process** for the data directory. Keep the process and computer running for commands and alerts to work. Hosting is not configured. Ctrl+C requests a clean shutdown.

## Follow games

Commands work in the destination channel's server for members with **Manage Server** permission. The bot verifies permissions on every invocation and rejects DMs. Command replies are private to the caller; qualifying price alerts go to the configured channel.

| Command | Result |
| --- | --- |
| `/games add url:<URL> name:<optional name> edition:<optional edition>` | Follows a product. Adding it does not contact the price source. |
| `/games list` | Lists products, editions, and IDs. |
| `/games remove id:<ID>` | Removes the product and its saved price history. |
| `/games check` | Checks now, saves observations, and sends qualifying alerts. |
| `/games check dry-run:true` | Previews offers without saving or sending alerts. |

Use English AllKeyShop comparison-page links, such as `https://www.allkeyshop.com/blog/buy-elden-ring-cd-key-compare-prices/`. Steam store URLs and individual seller links are not supported. Steam defaults to Standard edition; use the source's edition label, such as Deluxe, to follow another edition. Different editions are tracked separately. Supported WoW game-time links are recognized automatically.

The first successful regular check establishes a baseline quietly. Use a dry run to verify eligible offers after adding a product. Add, remove, and check run one at a time; `/games list` remains available while they run and shows the last saved product list. Steam alerts and check results identify the tracked edition. Long results arrive as a text attachment.

## How alerts work

- A drop must meet **both 10% and €2** by default. Small reductions accumulate against the initial or last alerted price. An unchanged deal stays quiet; another qualifying reduction can alert immediately.
- Returning sales can alert again after higher prices have been observed over **48 hours**. Short spikes do not reset the reference price. A gap longer than two check intervals restarts that recovery period, so downtime does not count as evidence of higher prices.
- Prices come from individual embedded offers, using AllKeyShop's listed card-payment total with reported fees and coupon discount. Cashback discounts are excluded. Confirm the final total at the store; the bot does not automate checkout.
- Steam offers must be in-stock keys for listed global/EU/Europe/EMEA/France regions and the chosen edition. Accounts, gifts, unknown restrictions, and other platforms are excluded. WoW game-time offers must be marked compatible with France.
- A source or delivery failure preserves the previous baseline. The next check can retry an alert if the price still qualifies; expired deals are not queued. Successful observations are saved per product.

## Settings and storage

`tracker.json` contains settings, followed products, and their price state together. It uses this shape; the empty game list below is illustrative, so do not overwrite an existing store with it:

```json
{
  "version": 1,
  "settings": {
    "minimumDropPercent": 10,
    "minimumDropEuro": 2,
    "checkIntervalMinutes": 60,
    "resetAfterHours": 48
  },
  "games": []
}
```

Stop the bot before changing settings. Check intervals must be between 1 and 35,791 minutes. Manage products through `/games` so their identity and saved state stay consistent. Back up `tracker.json` and keep a private backup of `.env`. To use another existing local data directory, set `TRACKER_DATA_DIR` and place `tracker.json` there.

The bot holds `.tracker.lock` for its lifetime. Never delete this lock while a bot process is running. Clean shutdown lets the current operation finish, saves successful progress, and releases the lock; network timeouts can delay completion. After a crash or power loss, stop all bot processes before deleting a stale lock and restarting. Storage failures stop the bot instead of continuing with unsaved state.

`tracker.json` is the only active data store. Legacy `games.json`, `state.json`, or migration backups are not read by this version. Keep any rollback backups separate; there is no compatibility mode or automatic import.

## Design and verification

- `bot.ts`: Discord connection, channel validation, command permissions, and application lifecycle.
- `tracker.ts`: product management, scheduling, serialized operations, and JSON persistence.
- `pricing.ts`: pure price-drop and returning-sale decisions.
- `sources.ts`: AllKeyShop requests, embedded-data extraction, and offer eligibility.
- `notifications.ts`: Discord alert formatting.

One process owns one store, so a database or external queue would add little here. Combining products and price state allows removal to be saved atomically. A small in-process queue prevents commands and scheduled checks from racing; a lifetime lock prevents a second writer. The bot sends alerts directly, avoiding separate webhook credentials and delivery code. There is one startup command and no separate CLI watcher.

See [the architecture review](ARCHITECTURE.md) for the design assessment, changes made, and reasons for retaining these boundaries.

Run `npm test` for type checking and offline tests, or `npm run typecheck` for type checking alone. Tests use captured offer fixtures, mocked network responses, and isolated temporary stores. Live Discord setup still needs verification with your bot and channel.

AllKeyShop's embedded data is not a documented public API. A site change or block may require a parser update; missing or unsuitable prices produce errors rather than fabricated deals. Zero-price placeholders are ignored. A confirmed Discord send followed by a crash before saving can occasionally produce a duplicate alert after restart.
