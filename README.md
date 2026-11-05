# PoorBot

A Discord bot that tracks game prices and sends alerts when they drop. Follow
games with slash commands and get hourly price updates, with mentions reserved
for drops that meet the alert thresholds.

**Built with:** TypeScript, Node.js and discord.js.

Prices come from AllKeyShop, using EUR offers compatible with France. Pricing
rules are separate from fetching and Discord delivery, and tracked games and
price state are saved in a JSON file.

## Try it locally

Requires Node.js 24.12 or newer.

```sh
npm ci
npm run demo
```

The offline demo uses invented prices and prints sample alerts. No Discord
account or API credentials are needed.

For a real Discord server, see the [setup and usage guide](docs/usage.md).
[Development notes](docs/usage.md#development) cover the code structure and tests;
`npm test` runs type checking and offline tests.

## License

[MIT](LICENSE) for original code. Third-party dependencies and external data
retain their own rights and notices.
