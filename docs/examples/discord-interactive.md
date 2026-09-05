# Discord interactive

The Discord surface uses the same provider-neutral interactive runtime model but has its own environment file and Discord credentials.

## 1. Create the Discord configuration

From the Agent Bridge checkout:

```bash
cp .env.discord-interactive.example .env.discord-interactive
```

Set at least:

```env
DISCORD_BOT_TOKEN=<bot-token>
DISCORD_APPLICATION_ID=<application-id>
DISCORD_ALLOWED_USER_IDS=<your-discord-user-id>
BRIDGE_PROJECT_DIR=/absolute/path/to/your/repository
```

`DISCORD_GUILD_ID` is optional. Supplying one registers commands to that guild for immediate propagation; leaving it blank uses global commands.

Set provider command paths when they are not already available on `PATH`. The canonical [`.env.discord-interactive.example`](../../.env.discord-interactive.example) contains the complete current surface configuration.

`.env.discord-interactive` is ignored by Git.

## 2. Start the Discord runtime

```bash
npx tsx src/index-discord-interactive.ts
```

The bot routes messages through the configured provider chain and exposes one-tap provider switching through Discord components. The selected provider can change without changing the Discord conversation/workstream.

## 3. Check provider configuration

Run Doctor against the Discord environment file:

```bash
BRIDGE_ENV_FILE=.env.discord-interactive npm run doctor
```

Doctor checks the provider executables and parses the configured interactive chain. Discord credential validation itself still occurs when the Discord runtime starts.
