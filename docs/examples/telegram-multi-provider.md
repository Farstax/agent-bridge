# Telegram with multiple providers

Use the source setup wizard when you want one Telegram bot that can switch between the coding-agent CLIs installed on the host.

## 1. Install the source checkout

```bash
git clone https://github.com/Farstax/agent-bridge.git
cd agent-bridge
npm install
```

Authenticate at least one supported provider CLI on the same host: Codex, Claude Code, Antigravity/Agy, Grok Build, or Cursor.

## 2. Create the interactive configuration

```bash
npm run setup
```

The wizard:

- detects supported provider CLIs through the same provider registry used by the runtime;
- asks for the Telegram bot token, allowed Telegram user IDs, and repository/project directory;
- writes only the detected provider commands into `.env.interactive`;
- keeps the normal runtime fallback order among the providers it found;
- writes the file with mode `0600` and refuses to replace an existing file unless you pass `--force`;
- runs the existing Doctor checks before declaring setup complete.

`.env.interactive` is ignored by Git. The wizard does not install systemd units, touch `/etc`, activate a release, or opt the runtime into `trusted` execution mode.

To deliberately replace an existing generated configuration:

```bash
npm run setup -- --force
```

For manual configuration instead, start from the canonical [`.env.interactive.example`](../../.env.interactive.example).

## 3. Start Agent Bridge

```bash
npm start
```

Open the bot in Telegram and send a normal message. Use `/cli` to see the active provider and switch with the inline controls. The selected provider is a property of the workstream; switching provider does not create a new conversation.

Useful controls include `/stop`, `/reset`, and `/btw`. Provider fallback uses `INTERACTIVE_CLI_CHAIN` from the generated configuration.

## 4. Re-run diagnostics

At any time:

```bash
npm run doctor
```

Doctor reports provider command availability and validates the configured interactive chain.
