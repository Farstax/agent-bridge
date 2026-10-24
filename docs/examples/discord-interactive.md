# Discord interactive — standalone setup

The Discord surface uses its own bot, source configuration and database, but the same Agent Bridge provider routing and Run engine. This guide is for a **source checkout**. Production installation uses the separately [qualified immutable-release installer](../INITIAL-INSTALL.md).

## Prerequisites

Node.js 24.22.1+ (Node 24 LTS), installed Agent Bridge dependencies, at least one authenticated provider CLI, a repository/project directory, and a Discord account permitted to create/install an application.

## 1. Create and configure the Discord application

1. Open [Discord Developer Portal](https://discord.com/developers/applications), select **New Application**, name it and save.
2. Under **General Information**, copy the **Application ID**. This is `DISCORD_APPLICATION_ID`, distinct from your personal Discord user ID.
3. Open **Bot**. Create/add the bot if necessary, enable the privileged **Message Content Intent**, and reset/copy the **bot token** into a private location. Never paste the token into a public issue or log.
4. Enable **Developer Mode** in Discord user settings, then right-click your own user/profile and choose **Copy User ID**. This is a numeric snowflake used in `DISCORD_ALLOWED_USER_IDS`.
5. In **Installation** (or **OAuth2 URL Generator**, depending on Developer Portal layout), prepare an installation with scopes **bot** and **applications.commands** and minimum permissions needed to view and send messages, read message history and interact in the chosen channel. Open the generated authorization URL and choose your test server. Workspace/server permissions may require admin approval.
6. Optionally copy the test **Guild/Server ID** using Developer Mode. This lets the runtime register guild-scoped commands promptly; without it, global command propagation may take longer. Do not confuse it with the app/user IDs.

## 2. Configure the standalone companion

From the OSS checkout, run the guided source wizard (or follow the manual steps below):

```bash
npm run setup -- --surface discord
```

For manual configuration:

```bash
cp .env.discord-interactive.example .env.discord-interactive
chmod 600 .env.discord-interactive
```

Set:

```dotenv
DISCORD_BOT_TOKEN=your-private-bot-token
DISCORD_APPLICATION_ID=your-application-id
DISCORD_ALLOWED_USER_IDS=your-numeric-discord-user-id
DISCORD_GUILD_ID=your-optional-server-id
BRIDGE_PROJECT_DIR=/absolute/path/to/your/repository
DB_PATH=/absolute/path/to/your/repository/.data/discord-interactive.sqlite
```

Keep the configuration outside source control. This existing companion consumes its token through the environment configuration; secure the file to the operating-system account running Agent Bridge. Configure `INTERACTIVE_CLI_CHAIN` and provider binaries using the [canonical example](../../.env.discord-interactive.example). A token alone does not prove bot readiness; Discord's actual gateway verifies credentials when the companion starts.

## 3. Bootstrap the strict database

Use a **new, dedicated** absolute path and the guarded bootstrap. Never point Discord at a Telegram or Slack DB:

```bash
mkdir -p /absolute/path/to/your/repository/.data
node --import tsx scripts/rollout-db.ts bootstrap \
  --db /absolute/path/to/your/repository/.data/discord-interactive.sqlite \
  --role discord \
  --confirm-new-role /absolute/path/to/your/repository/.data/discord-interactive.sqlite
```

Do not repeat bootstrap on an existing database or delete it to repair a startup failure. Existing installations must use the guarded migration/upgrade path.

## 4. Check providers and start

```bash
BRIDGE_ENV_FILE=.env.discord-interactive npm run doctor
npx tsx src/index-discord-interactive.ts
```

Wait for Discord gateway readiness and command registration. Send a direct message or a message in a permitted server channel as your allowlisted user. Provider switching reuses the same workstream. If nothing responds, check that the bot is installed to the intended guild, has channel access, Message Content Intent is enabled, IDs are correct, the provider CLI is authenticated, and Doctor passes. Do not assume Doctor alone validates a live Discord gateway.

**Other surfaces:** [Telegram](telegram-multi-provider.md) · [Slack](../slack.md). The source wizard supports Telegram, Discord and Slack, but it does not install a production systemd unit.
