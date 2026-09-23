# Initial production installation

Initial installation and guarded rollout have separate responsibilities:

- `agent-bridge-install.py` turns a fresh host into an Agent Bridge installation once.
- `agent-bridge-deploy` moves an existing installation between exact releases.

Do not use guarded rollout to create a missing baseline. Do not use the source-oriented `scripts/install.sh` as the production release activator.

## Inputs

The initial installer requires:

- an exact qualified `agent-bridge-<commit>.tar.gz` release archive;
- `scripts/agent-bridge-install.py` and `scripts/release-stage.py` from the same trusted commit, placed together;
- an existing non-root runtime account;
- an absolute, regular Node.js 24+ binary;
- the environment variables for each service that should be installed.

The runtime account's existing unrestricted passwordless sudo rule is an installation invariant. The installer verifies it with a non-cached `sudo -k -n true` check and does not create, narrow or replace the rule.

At least one service token is required. A service is installed only when its token is supplied. For example, an interactive-only installation can use:

```bash
sudo env \
  TELEGRAM_ALLOWED_USER_IDS=123456789 \
  TELEGRAM_BOT_TOKEN_INTERACTIVE='123456:replace-me' \
  CLAUDE_ACP_COMMAND=/opt/agent-bridge/releases/current/node_modules/.bin/claude-agent-acp \
  ANTIGRAVITY_COMMAND=/home/agentbridge/.local/bin/agy \
  python3 scripts/agent-bridge-install.py \
    --release /root/agent-bridge-<commit>.tar.gz \
    --runtime-user agentbridge \
    --node-bin /home/agentbridge/.nvm/versions/node/v24.15.0/bin/node \
    --environment production-agent-bridge
```

The platform may safely extract the installer and its sibling staging helper from the already resolved release archive, then invoke the command against the original archive. The installer independently verifies the archive manifest, every payload entry and the embedded qualification identity before changing the host.

## Optional interactive Telegram credential

A deployment owner can supply the interactive Telegram token with a systemd credential instead of leaving it in `/etc/default/agent-bridge-interactive`.

The credential name is `telegram-bot-token-interactive`. When that regular file is present under `$CREDENTIALS_DIRECTORY`, the interactive service reads it at startup and exports `TELEGRAM_BOT_TOKEN_INTERACTIVE` for the service process. The value is not copied into an env file, a defaults file, or a log.

An attached readable credential replaces a legacy environment assignment for that process. If the credential file is absent, the existing `TELEGRAM_BOT_TOKEN_INTERACTIVE` environment value is used unchanged. A present credential that is unreadable or malformed fails startup. Agent Bridge does not create a replacement copy.

Agent Bridge does not create, encrypt, rotate, provision, or delete the credential. That lifecycle belongs to the deployment environment. The stock unit has no `LoadCredential=` or `LoadCredentialEncrypted=` dependency. A deployment owner binds the credential with a drop-in when needed:

```ini
[Service]
LoadCredentialEncrypted=telegram-bot-token-interactive:/path/to/deployment-owned-credential
```

That drop-in is sufficient when the service uses Agent Bridge's stock `agent-bridge-interactive.service`, because the stock unit already invokes `scripts/load-interactive-telegram-credential.sh` before the TypeScript runtime.

A deployment owner that generates its own systemd unit and starts `src/index-interactive.ts` directly must also invoke the shipped helper in its `ExecStart`; attaching the credential alone only supplies `$CREDENTIALS_DIRECTORY` and does not populate `TELEGRAM_BOT_TOKEN_INTERACTIVE`. For example, with the release as the working directory:

```ini
[Service]
LoadCredentialEncrypted=telegram-bot-token-interactive:/path/to/deployment-owned-credential
ExecStart=/opt/agent-bridge-ux/scripts/load-interactive-telegram-credential.sh /usr/local/bin/npx tsx src/index-interactive.ts
```

The exact runtime command remains deployment-owned; the stable Agent Bridge contract is the helper path/name and the `telegram-bot-token-interactive` credential name.

## Installation result

A successful installation:

1. refuses to continue if `/opt/agent-bridge/releases/current` already exists;
2. writes root-owned mode `0600` service defaults;
3. stores service databases under `/var/lib/agent-bridge/<service>/bridge.sqlite`, outside the immutable release;
4. installs the configured systemd units and cleanup timer;
5. installs `agent-bridge-deploy` and its private helpers as root-owned commands;
6. writes the fixed root-owned `/etc/agent-bridge/rollout.conf` inventory and helper hashes;
7. bootstraps each selected, previously absent service database as the runtime user, with its fixed provenance role;
8. stages the exact immutable release and atomically creates the first `current` pointer;
9. starts only the configured services;
10. verifies active services and SQLite integrity;
11. writes `/var/lib/agent-bridge/installation-result.json`.

If bootstrap, startup, or acceptance fails, the installer stops the selected units, removes the newly created pointer, and removes only the database targets it proved absent before installation. The staged release and failure result remain for diagnosis or a safe retry.

## Subsequent releases

After the first successful installation, use only the guarded deployer:

```bash
sudo agent-bridge-deploy --release agent-bridge-<next-commit>.tar.gz
```

The initial installer refuses to overwrite an existing active pointer, so it cannot become an accidental second upgrade path.

## Source and development installation

`scripts/install.sh` remains useful for a source checkout or development host where an operator wants interactive prompts and local `.env.*` files. It installs and enables units but deliberately does not activate an immutable release or start production services. It is not the platform's fresh-workspace installation command.
