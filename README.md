# agent-bridge

Operations bridge for CLI coding agents across Telegram and Discord. It connects chat messages, slash commands, approval buttons, and background worker jobs to Codex, Antigravity, and Claude Code while keeping state in SQLite and process lifecycle under systemd.

## What it does

Runs one or more chat-facing services from the same TypeScript codebase:

- dedicated Telegram bots for a single CLI backend
- one unified Telegram bot with `/cli` switching and automatic CLI fallback
- a Telegram worker bot for queued engineering jobs, GitHub issues, PRs, stale PR handling, and merge approvals
- optional Discord single-CLI and interactive bots through the Discord Gateway
- optional health bot that reports host, bridge, and external-system checks

Interactive requests stream responses back to the chat. Background worker jobs run through a durable SQLite queue and report only at useful boundaries.

## Service matrix

| Service | Entry point | Surface | Purpose |
|---|---|---|---|
| `agent-bridge-codex.service` | `src/index.ts` | Telegram | Dedicated Codex bot |
| `agent-bridge-antigravity.service` | `src/index.ts` | Telegram | Dedicated Antigravity bot |
| `agent-bridge-claude.service` | `src/index.ts` | Telegram | Dedicated Claude Code bot |
| `agent-bridge-interactive.service` | `src/index-interactive.ts` | Telegram | One bot with `/cli`, per-chat CLI preference, and CLI-to-CLI fallback |
| `agent-bridge-worker-bot.service` | `src/index-worker.ts` | Telegram | Autonomous worker queue, GitHub issue/PR lifecycle, merge gate |
| `agent-bridge-health.service` | `src/index-health.ts` | Telegram | Scheduled health reports and optional CLI suggestions |
| `agent-bridge-discord-interactive.service` | `src/index-discord-interactive.ts` | Discord | Discord bot with switchable CLI routing |
| `agent-bridge-tmp-cleanup.service` + `.timer` | `scripts/reap-tmp-artifacts.sh` | — | Daily sweep of leftover `/tmp` run artifacts and merged git worktrees (see [Temporary artifact cleanup](#temporary-artifact-cleanup)) |

## Features

- **Streaming responses** — edits a placeholder message as the CLI outputs, then replaces with the final result
- **Session continuity** — persists CLI session IDs per chat in SQLite so conversations resume across restarts
- **Kill switch** — `/stop` or `/cancel` aborts the running process immediately
- **Forum/topic support** — threads replies into the correct Telegram forum topic
- **Media group batching** — aggregates multi-photo messages into a single agent prompt
- **Model fallback** — automatically retries with a smaller model on capacity exhaustion (all bots)
- **Concurrency lock** — one execution per chat at a time (SQLite atomic lock, no race conditions)
- **Circuit breaker** — auto-clears a corrupt or stale session after 2 consecutive timeout/signal failures
- **Agy stall detection** — monitors Antigravity log files for planner loops (`PlannerResponse without ModifiedResponse encountered`) and aborts execution early to prevent infinite churn
- **Session TTL** — sessions older than 7 days are automatically cleared on startup to prevent stale resume loops
- **Orphan and restart recovery** — kills leftover CLI subprocesses from previous runs on boot, transitions interrupted SQLite runs to `failed`, and notifies active Telegram/Discord chats to resume using `provide update` or `continue`
- **Bridge-owned project memory** — conversation-aware memory retrieval and guarded agent writes through `AGENT_BRIDGE_CONTEXT_COMMAND`
- **Shared skills installer** — optional SDLC skills can be installed across Codex, Antigravity, and Claude Code
- **SOUL.md design** — proposed bridge-level persona contract for consistent voice, values, boundaries, and workflow across agents
- **Rate limit handling** — automatic retry on Telegram 429 responses
- **Discord support** — Gateway transport, slash commands, message chunking, and an interactive Discord entry point
- **Autonomous worker lane** — durable job queue for reviews, feature plans, TDD implementation, draft PRs, stale PR digests, and merge approvals
- **Health monitoring** — dedicated scheduler service that runs health checks at a configurable interval and sends formatted reports to a Telegram chat; extensible to any external system via a one-file JSON script

## Requirements

- Node 24+
- `codex` on `$PATH` — `npm install -g @openai/codex`
- `agy` on `$PATH` — installed via `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- `claude` on `$PATH` — `npm install -g @anthropic-ai/claude-code` (required only if using the Claude bot)
- `npm` on `$PATH`
- Telegram bot tokens from BotFather for the services you run
- Optional: a Discord application/bot token with Message Content intent enabled
- Optional worker lane: GitHub CLI access through `GITHUB_TOKEN_FILE`

## Setup

> Maintenance note: `codex` and `claude` are external global installs — **not** bundled as npm dependencies. Install them separately before running `install.sh`. The `@google/agy-cli` entry in `package.json` points to a committed mock at `test/mocks/mock-agy-cli` for offline testing only; the real `agy` binary is installed by the Google Antigravity installer.

**Recommended — let the installer generate env files:**

```bash
sudo bash scripts/install.sh
```

The installer prompts for bot tokens, user IDs, Discord credentials, and paths, then writes local env files from the example templates and installs the standard systemd services. Codex and Antigravity are the primary dedicated services; Claude, health, Discord, and Discord interactive are installed when their tokens/default files are present.

The unified Telegram interactive bot and worker bot have service templates and env examples, but are intentionally operator-enabled: create `/etc/default/agent-bridge-interactive` or `/etc/default/agent-bridge-worker-bot` from the matching `.env.*.example`, then install/enable those units once their tokens and flags are correct.

The installer records the absolute Node binary path as `NODE_BIN` in each systemd defaults file and the service templates run `tsx` through that binary. This avoids systemd falling back to an older ambient `node` on the login shell path.

**Manual setup** (dev / no-systemd):

```bash
npm install
cp .env.codex.example .env.codex
cp .env.antigravity.example .env.antigravity
cp .env.claude.example .env.claude
cp .env.interactive.example .env.interactive
cp .env.worker.example .env.worker
cp .env.discord-interactive.example .env.discord-interactive
```

Then fill in the relevant token(s) and paths in each file:
- `TELEGRAM_BOT_TOKEN_*` — bot token from @BotFather
- `TELEGRAM_BOT_TOKEN_INTERACTIVE` — unified Telegram bot token
- `TELEGRAM_BOT_TOKEN_WORKER` — worker bot token
- `TELEGRAM_BOT_TOKEN_HEALTH` — optional separate token for the health bot service
- `TELEGRAM_ALLOWED_USER_IDS` — your Telegram numeric user ID
- `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_ALLOWED_USER_IDS` — optional Discord bridge credentials
- `BRIDGE_ROOT_DIR` / `BRIDGE_PROJECT_DIR` — deployment paths supplied by environment or installer
- `*_COMMAND` — absolute path to each CLI binary (use `which codex`, `which agy`, `which claude`)
- `*_PROJECT_DIR` — working directory passed to the CLI (optional; defaults to `BRIDGE_PROJECT_DIR`)
- `INTERACTIVE_CLI_CHAIN` / `WORKER_CLI_CHAIN` — CLI fallback order for unified and worker services
- Bridge-owned project memory is exposed to spawned agents through `AGENT_BRIDGE_CONTEXT_COMMAND`

Run a single bot for development:

```bash
BRIDGE_ENV_FILE=.env.antigravity ./node_modules/.bin/tsx src/index.ts
BRIDGE_ENV_FILE=.env.claude ./node_modules/.bin/tsx src/index.ts
BRIDGE_ENV_FILE=.env.interactive ./node_modules/.bin/tsx src/index-interactive.ts
BRIDGE_ENV_FILE=.env.worker ./node_modules/.bin/tsx src/index-worker.ts
BRIDGE_ENV_FILE=.env.discord-interactive ./node_modules/.bin/tsx src/index-discord-interactive.ts
```

Important:
- Each service reads its own env file (`.env.codex`, `.env.antigravity`, `.env.claude`)
- `BRIDGE_ENV_FILE` must point at the bot-specific env file
- `BRIDGE_PROJECT_DIR` should point at the agent-bridge repo
- `NODE_BIN` must point at Node 24+ for systemd deployments
- `CODEX_PROJECT_DIR` / `ANTIGRAVITY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` may override the CLI working dir per bot

## Commands

| Command | Action |
|---|---|
| `/reset` | Clear the current CLI session (start fresh) |
| `/models` | Show and change the active model |
| `/effort` | Show and change reasoning effort |
| `/cli` | Interactive bot only: show/change active CLI |
| `/skills` | List bundled shared skills and install/repair commands |
| `/stop` | Abort the currently running CLI process |
| `/cancel` | Same as `/stop` |
| `/btw <prompt>` | Run a fresh, read-only, one-off side question without disturbing the active session |

All other text is forwarded to the active CLI as a prompt. Discord uses slash-command registration for the same command set where supported.

## Autonomous worker loop

A separate worker bot (`agent-bridge-worker-bot.service`, `src/index-worker.ts`)
runs background engineering jobs over a durable SQLite queue: defect scans
(`/review`), feature planning (`/feature`), TDD implementation of approved work
items, resumable orchestrated implementation jobs, and draft-PR creation — with
a Telegram merge gate as the only routine human approval. Implementation jobs
run in disposable git clones, never in live checkouts, and merges are blocked
unless the PR head SHA still matches the approval and CI checks are green.

Worker commands: `/review`, `/feature`, `/issues`, `/issue`, `/jobs`, `/job`,
`/approvals`, `/chain`, `/models`, `/effort`. `/models` follows the active CLI;
`/chain` keeps the legacy-only response when no desired role revision exists.
When configured, it reports the exact three-role assignment as
`configured_dormant`, states `Role routing: disabled`, and separately shows the
effective legacy interactive, code, and scribe chains. Desired assignments do
not participate in dispatch. The worker also schedules `pr_watch` jobs to react
to CI status, stale PRs, and held/refresh/close decisions.

Full guide: `docs/WORKER-GUIDE.md`. Architecture:
`docs/architecture/engineering-worker.md`. Design history and Phase 9
implementation record: `docs/autonomous-agent-bridge-research.md`.

### Parallel development warning

Companion and individual provider bots remain available for development work
and use the canonical checkout without the worker worktree lock. The worker bot
uses isolated per-job workspaces with locking enabled. Do not perform parallel
development on overlapping files through a companion/provider bot and the
worker: worker workspaces start from a snapshot and do not see later
uncommitted changes in the canonical checkout, and the bridge does not
automatically reconcile those edits.

## Configuration

Each service reads its own `.env` file. Only the token for that service's bot is required.

| Variable | Bot | Default | Description |
|----------|-----|---------|-------------|
| `TELEGRAM_BOT_TOKEN_CODEX` | Codex | — | Bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN_CLAUDE` | Claude | — | Bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN_ANTIGRAVITY` | Antigravity | — | Bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN_INTERACTIVE` | Interactive | — | Unified Telegram bot token |
| `TELEGRAM_BOT_TOKEN_WORKER` | Worker | — | Worker bot token |
| `DISCORD_BOT_TOKEN` | Discord | — | Discord bot token |
| `DISCORD_APPLICATION_ID` | Discord | — | Discord application ID for slash commands |
| `DISCORD_ALLOWED_USER_IDS` | Discord | — | Comma-separated Discord user snowflake IDs |
| `TELEGRAM_ALLOWED_USER_IDS` | All | — | Comma-separated Telegram user IDs. Also accepts legacy `TELEGRAM_ALLOWED_USER_ID`. |
| `CODEX_COMMAND` | Codex | `codex` | CLI binary path |
| `ANTIGRAVITY_COMMAND` | Antigravity | `agy` | CLI binary path |
| `CLAUDE_COMMAND` | Claude | `claude` | CLI binary path |
| `CODEX_MODEL_PREFERENCE` | Codex | — | Comma-separated model list; first = default, rest = fallbacks |
| `ANTIGRAVITY_MODEL_PREFERENCE` | Antigravity | — | Comma-separated model list; first = default, rest = fallbacks |
| `CLAUDE_MODEL_PREFERENCE` | Claude | — | Comma-separated model list; first = default, rest = fallbacks |
| `CODEX_EFFORT` | Codex | `medium` | Reasoning effort; mapped to `model_reasoning_effort` |
| `ANTIGRAVITY_EFFORT` | Antigravity | `medium` | Recorded/displayed for parity only; Agy has no separate effort CLI flag |
| `CLAUDE_EFFORT` | Claude | `medium` | Reasoning effort; mapped to `--effort` |
| `CODEX_PROJECT_DIR` | Codex | — | Working dir for CLI execution (overrides `BRIDGE_PROJECT_DIR`) |
| `ANTIGRAVITY_PROJECT_DIR` | Antigravity | — | Working dir for CLI execution (overrides `BRIDGE_PROJECT_DIR`) |
| `CLAUDE_PROJECT_DIR` | Claude | — | Working dir for CLI execution (overrides `BRIDGE_PROJECT_DIR`) |
| `DB_PATH` | All | `.data-<bot>/bridge.sqlite` | SQLite database path |
| `CLI_TIMEOUT_MS` | All | `0` (disabled) | Optional hard execution timeout (ms) |
| `CLI_IDLE_TIMEOUT_MS` | All | `0` (disabled) | Optional kill timeout after this many ms with no output |
| `FETCH_TIMEOUT_MS` | All | `45000` | Telegram API fetch timeout (ms) |
| `POLL_INTERVAL_MS` | All | `1000` | Telegram long-poll interval (ms) |
| `AGENT_BRIDGE_SOUL_PATH` | All | `$BRIDGE_PROJECT_DIR/SOUL.md` | Optional SOUL.md persona contract injected into each CLI prompt |
| `AGENT_BRIDGE_SOUL_MODE` | All | `summary` | `summary`, `full`, or `off` persona injection mode |
| `TELEGRAM_DOCUMENT_FALLBACK_ENABLED` | Telegram bots | `false` | Opt in to in-memory `response.md` attachments for exceptional oversized/code-heavy final responses |
| `TELEGRAM_LAYOUT_DOCUMENT_THRESHOLD` | Telegram bots | `3500` | Attachment threshold used only when `TELEGRAM_DOCUMENT_FALLBACK_ENABLED=true` |
| `TELEGRAM_LAYOUT_CODE_BLOCK_THRESHOLD` | Telegram bots | `3` | Code-block attachment threshold used only when `TELEGRAM_DOCUMENT_FALLBACK_ENABLED=true` |
| `INTERACTIVE_DEFAULT_CLI` | Interactive | `codex` | Default CLI for new interactive chats |
| `INTERACTIVE_CLI_CHAIN` | Interactive | `codex,claude,antigravity` | CLI fallback order after model fallbacks are exhausted |
| `BRIDGE_COMPACTION_CHAIN` | Interactive/Worker | — | Optional ordered `provider[:model]` recovery targets; the healthy caller-selected provider is first, duplicates/invalid targets and exhausted providers are excluded, and Kimchi remains fail-closed |
| `BRIDGE_COMPACTION_MAX_ATTEMPTS` | Interactive/Worker | `3` | Maximum provider/model targets tried for each structured compaction output; bounded to 8 |
| `BRIDGE_COMPACTION_REPAIR_ATTEMPTS` | Interactive/Worker | `1` | Invalid structured-output repair attempts per provider/model target; bounded to 0 or 1 |
| `WORKER_ENABLED` | Worker | `false` | Master switch for autonomous job commands |
| `WORKER_CLI_CHAIN` | Worker | `codex,claude,antigravity` | CLI fallback order for worker interactive chat |
| `WORKER_CODE_CLI_CHAIN` | Worker | `codex,claude` | Code-writing job fallback order; `antigravity` is stripped if present |
| `WORKER_SCRIBE_CLI_CHAIN` | Worker | `antigravity,codex,claude` | Read-only/prose worker job fallback order for scans, plans, summaries, docs |
| `WORKER_ROLE_ASSIGNMENTS_JSON` | Worker | — | Optional exact three-role desired assignment array; persisted as `configured_dormant` and never used for current dispatch |
| `WORKER_ROLE_ASSIGNMENT_SCOPE` | Worker | `worker:default` | Bounded scope key for dormant desired role-assignment revisions |
| `WORKER_CODE_CLI_COMMAND` | Worker | first `WORKER_CODE_CLI_CHAIN` entry | Primary CLI command for code-writing jobs |
| `WORKER_SCRIBE_CLI_COMMAND` | Worker | `DEFECT_SCAN_CLI_COMMAND` or first `WORKER_SCRIBE_CLI_CHAIN` entry | Primary CLI command for read-only/prose jobs |
| `BRIDGE_ASYNC_ENABLED` | All | `true` | Enable streaming (disable for sync/plain mode) |
| `BRIDGE_EXECUTION_MODE` | All | `safe` | `safe` or `trusted` (bypasses CLI approval prompts) |
| `BRIDGE_BUSY_MESSAGE_MODE` | All | `augment` | `augment` folds ordinary busy messages into one logical task; `interrupt` aborts and runs only the latest; `queue` retains durable FIFO turns |
| `BRIDGE_WORKSPACE_LOCK_MODE` | All | `on` | `on` protects Git worktree CLI execution; companion/provider services use `off` when intentionally sharing the canonical checkout |
| `BRIDGE_ADVISOR_ENABLED` | Companion/Worker | `false` | Enable frontier advisor calls; kill switch for the capability |
| `BRIDGE_ADVISOR_MODE` | Companion/Worker | `manual` | `manual`, `suggest`, or `auto` consultation policy |
| `BRIDGE_ADVISOR_CHAIN` | Companion/Worker | — | Up to two ordered `provider:model` targets; tool-free invocation requires claude or codex targets |
| `BRIDGE_ADVISOR_MAX_CALLS_PER_TURN` | Companion | `1` | Maximum logical advisor requests for one Telegram/agent turn |
| `BRIDGE_ADVISOR_MAX_CALLS_PER_TASK` | Worker | `2` | Maximum logical advisor requests for one worker task |
| `BRIDGE_ADVISOR_TIMEOUT_MS` | Companion/Worker | `120000` | Hard timeout for each advisor provider attempt |
| `BRIDGE_ADVISOR_CONTEXT_MAX_CHARS` | Companion/Worker | `24000` | Redacted advisor context character budget |
| `PR_DEFECT_SCAN_ENABLED` | Worker | `false` | Enable pre-merge defect scanning when CI checks pass |
| `BRIDGE_PROJECT_DIR` | All | current working directory | Repo path (used as default CLI working dir and DB location) |

| `BRIDGE_ROOT_DIR` | All | `$HOME` | Fallback working dir when no `*_PROJECT_DIR` is set |

Effort levels are standardized as `low`, `medium`, `high`, `xhigh`, and `max`;
default is `medium`. Manual `/effort` overrides are persisted in SQLite. Worker
jobs select effort by task: scribe/read-only jobs use `medium`; code-writing
jobs (`tdd_implementation`, `orchestrated_task`) use `high`. Agy effort is an
explicit no-op because the current CLI exposes low/high variants through model
labels, not a standalone effort parameter.

`GEMINI_*` env names remain as deprecated compatibility aliases for
Antigravity/Agy deployments (`TELEGRAM_BOT_TOKEN_GEMINI`, `GEMINI_COMMAND`,
`GEMINI_MODEL_PREFERENCE`, `GEMINI_PROJECT_DIR`). Prefer the `ANTIGRAVITY_*`
names for new config; Agy is the supported replacement path for the older Gemini
CLI naming.

## Group and multi-user usage

The bot works in Telegram groups and supergroups.

### Adding a bot to a group — required order

**Do this before adding the bot to any group.** Changing settings after the fact requires removing and re-adding the bot to take effect.

1. **Disable Group Privacy in BotFather first** — `/mybots → [your bot] → Bot Settings → Group Privacy → Turn off`. Without this, Telegram silently drops all non-command, non-mention messages. The setting must be OFF *before* the bot joins the group; toggling it after the bot is already a member does not retroactively fix delivery — you must remove and re-add the bot.

2. **Add the bot to the group.**

3. **Grant admin rights if using forum topics** — In forum-style supergroups (groups with Topics enabled), the bot must be a group admin with at least "Post Messages" permission to reply in topics. Without this, responses fail with `TOPIC_CLOSED`. Standard groups without topics do not require admin rights.

Commands work with or without the bot username suffix: `/reset` and `/reset@mybotname` are both recognised.

Interactive bot command diagnostics are logged with sanitized group metadata:
`[interactive] update.received` for processable group updates and
`[interactive] update.ignored` with a `contentDetail` such as `new_chat_members`,
`photo`, `document`, or `command_for_other_bot` when an update is intentionally
skipped. If a dedicated bot responds in the group but the interactive bot does
not, compare BotFather privacy, remove/re-add the interactive bot after changing
privacy, and check these log lines before changing code.

**Per-topic sessions:** In forum-style supergroups, each topic gets its own isolated CLI session. Sending in Topic A and Topic B maintains independent conversation threads with the agent.

**Multiple users:** Set `TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list of Telegram user IDs. Each user in a private chat has their own isolated session. In groups with multiple allowed users, sessions are isolated per-user per-topic.

```
TELEGRAM_ALLOWED_USER_IDS=111111111,222222222
```

## Discord channel and thread usage

Discord bots use channel snowflakes as the conversation boundary. A normal
server channel, a DM channel, and every Discord thread each have a distinct
`channel_id`, so each gets its own CLI lock, queue, model/session state, and
fallback-chain context.

The Discord interactive entry point adapts those snowflakes into deterministic
numeric aliases for the shared Telegram-shaped engine, then maps outbound sends
back to the original Discord channel snowflake. This preserves session isolation
while keeping the shared engine reusable.

Operational diagnostics are sanitized:

- `[discord-interactive] update.received` means an allowed user sent processable text
- `[discord-interactive] update.ignored` reports `unauthorized_author`, `bot_author`, or `empty_content`

Discord requirements:

- `DISCORD_ALLOWED_USER_IDS` must contain Discord user snowflake IDs, not usernames
- Message Content intent must be enabled in the Discord Developer Portal for plain-message routing
- Slash commands may be guild-scoped with `DISCORD_GUILD_ID` for immediate propagation

## Project memory

Project memory is stored in the bridge SQLite database in `project_memories`
with an FTS5 index. Spawned agents receive `AGENT_BRIDGE_CONTEXT_COMMAND` and
can retrieve or write guarded memories with:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<query>"
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '<json>'
```

Successful responses may also include a hidden `agent-bridge-memory` sidecar;
the bridge strips it before delivery/history and stores valid candidates.

`/compact` is the single automatic durable-memory distillation path. The
former post-turn extractor (`BRIDGE_MEMORY_EXTRACTOR_ENABLED`) has been
removed; compaction produces both a conversation summary and validated
memory candidates in one deliberate step instead of running an extra CLI
call after every successful reply.

Set `BRIDGE_CONTEXT_INJECTION_POLICY=handoff_once` to inject full Agent
Bridge context only on a fresh session (no native CLI session, a pending
manual-switch/fallback handoff, or after `/compact`/invalid-session
recovery resets the session), then rely on the provider-native session
for continuity. Defaults to `always` (inject on every turn), matching
prior behavior. Context-command env vars (`AGENT_BRIDGE_CONTEXT_COMMAND`,
etc.) remain available under both policies. Recommended for
platform-managed workspaces; self-hosted deployments can leave it unset.

## Shared skills

`agent-bridge` also bundles reusable SDLC skills:

- `requirements-to-acceptance` — turn vague requests into requirements, non-goals, acceptance criteria, and verification steps
- `risk-based-test-strategy` — choose test depth based on blast radius and regression risk
- `red-green-refactor-tdd` — use red-green-refactor TDD for features, bug fixes, behavior changes, and refactoring
- `release-readiness-review` — check release, rollback, observability, docs, and post-release validation readiness
- `git-sandbox` — isolate work using git worktrees and feature branches, creating Draft PRs and validating changes before merging

Skills are stored once under:

```bash
~/.agents/skills/<skill-name>
```

Then they are projected into each CLI's native skills directory:

```bash
~/.codex/skills/<skill-name>
~/.gemini/antigravity/skills/<skill-name>
~/.claude/skills/<skill-name>
```

Global instruction files are not modified by the skills installer.
Fresh and deployment installs project all bundled skills into native CLI directories by default. Set `AGENT_BRIDGE_SKILLS=none` to skip this.

Manage skills manually:

```bash
npm run skills -- list
npm run skills -- install red-green-refactor-tdd
npm run skills -- verify
npm run skills -- uninstall red-green-refactor-tdd
```

Native CLI entries are symlinks by default. Use copy mode if a CLI does not discover symlinked skills correctly:

```bash
npm run skills -- install red-green-refactor-tdd --force --link-mode copy
```

During installation, override the default bundled set with a comma-separated list for non-interactive setup:

```bash
AGENT_BRIDGE_SKILLS=red-green-refactor-tdd,risk-based-test-strategy sudo bash scripts/install.sh
```

Optional install variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BRIDGE_SKILLS` | all bundled skills | Comma-separated bundled skills to install during `install.sh` or `upgrade.sh`; use `none` to skip. |
| `AGENT_BRIDGE_SKILL_LINK_MODE` | `symlink` | Native CLI projection mode: `symlink` or `copy`. |

If verification reports stale symlinks or missing native entries, repair them with:

```bash
npm run skills -- verify --fix
```

## Health monitoring

The dedicated health service runs a `HealthScheduler` that polls plugins at a configurable cadence and sends formatted status reports to a Telegram chat. By default it owns a separate Telegram bot. Set `HEALTH_BOT_MODE=integrated` to share the interactive bot instead: the health service remains a separate, send-only scheduler while the interactive service is the only Telegram poller and registers `/health`. `/health` acknowledges immediately and reports after checks finish; `/health status` returns the latest stored health report.

### Built-in plugins

| Plugin | What it checks |
|--------|----------------|
| `SelfPlugin` | DB file accessibility, DB read liveness |
| `ServerPlugin` | System resource metrics (CPU load, RAM, swap, zombies, uptime) and security policies (UFW status, SSH key permissions, local environment file permissions) |
| `ExternalPlugin` | Spawns any shell command and parses its stdout as a `HealthReport` JSON |

`SelfPlugin` and `ServerPlugin` are active by default. `ExternalPlugin` wraps any system you want to monitor.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_MONITOR_ENABLED` | `false` | Set to `true` in the health service defaults to enable scheduled checks |
| `HEALTH_BOT_MODE` | `standalone` | `standalone` requires `TELEGRAM_BOT_TOKEN_HEALTH` and owns polling; `integrated` uses `TELEGRAM_BOT_TOKEN_INTERACTIVE` and makes health send-only |
| `HEALTH_MONITOR_CADENCE_SECONDS` | `3600` | How often to run each plugin (seconds) |
| `HEALTH_MONITOR_AUTONOMY` | `report` | `report` — formatted report only; `suggest` — also spawns a CLI to diagnose and propose fixes |
| `HEALTH_MONITOR_CHAT_ID` | — | Telegram chat ID to receive reports; if unset, reports are logged to stdout only |
| `HEALTH_SUGGEST_BOT` | `claude` | Which installed CLI diagnoses amber/red reports: `codex`, `antigravity`, or `claude` |
| `HEALTH_SUGGEST_COMMAND` | bot default | Optional command override for the suggestion CLI. Defaults to `codex`, `agy`, or `claude` based on `HEALTH_SUGGEST_BOT` |
| `HEALTH_SUGGEST_MODEL_PREFERENCE` | — | Optional comma-separated model preference list for suggestion CLI fallback |
| `HEALTH_SERVER_MONITOR_ENABLED` | `1` | Set to `0` to disable the built-in server resource monitor plugin |
| `HEALTH_CPU_LOAD_AMBER_MULTIPLIER` | `1.0` | Threshold multiplier for CPU load warning (e.g. `1.0` * CPU count) |
| `HEALTH_CPU_LOAD_RED_MULTIPLIER` | `1.5` | Threshold multiplier for CPU load critical (e.g. `1.5` * CPU count) |
| `HEALTH_CPU_LOAD_AMBER_THRESHOLD` | — | Override to set absolute CPU load warning threshold |
| `HEALTH_CPU_LOAD_RED_THRESHOLD` | — | Override to set absolute CPU load critical threshold |
| `HEALTH_SWAP_MONITOR_ENABLED` | `true` | Set to `false` to disable the built-in swap check |
| `HEALTH_SWAP_AMBER_PCT` | `80` | Swap warning threshold percentage |
| `HEALTH_SWAP_RED_PCT` | `95` | Swap critical threshold percentage |
| `HEALTH_CONTENT_CRAWLER_ENABLED` | `0` | Set to `1` to enable the content-crawler external plugin |
| `HEALTH_CONTENT_CRAWLER_SCRIPT` | `~/content-crawler/scripts/health_check.py` | Override the script path |

### Additional Health Check Behaviors

- **Smart Swap Warnings**: To reduce false alerts, swap usage is only flagged as `amber` if RAM usage (memory status) is also not healthy (`green`). Critical status (`red`) is flagged unconditionally if swap usage exceeds `HEALTH_SWAP_RED_PCT` (default: 95%).
- **Version-Distance CLI Update Status**: Instead of reporting every update as a warning, updates report status based on how many versions behind the installed CLI is:
  - `>= 10` versions behind: `red` (critical)
  - `>= 3` versions behind: `amber` (warning)
  - `< 3` versions behind: `green` (nominal)
  The check message includes the version difference details.


### Suggest mode

When `HEALTH_MONITOR_AUTONOMY=suggest` the bridge sends a second message for every amber or red report. It routes the failing checks through the CLI configured in `HEALTH_SUGGEST_BOT` using the **same auth, invocation, parser, and Telegram rendering path as normal user messages** (`buildCliInvocation → runCli → parseCliResult → sendTelegramMessage`). The newer `HEALTH_CLI_*` variable names are also accepted as aliases, but `HEALTH_SUGGEST_*` is the documented form. The response appears as:

💡 *Suggested actions:*

1. Restarts the health monitor after a configuration or code change.

```bash
sudo systemctl restart agent-bridge-health
```

2. Raises the heap limit only if memory pressure is genuine.

```bash
echo 'NODE_OPTIONS="--max-old-space-size=512"' | sudo tee -a /etc/default/agent-bridge-health
sudo systemctl restart agent-bridge-health
```

To enable suggest mode, add to your `.env` file:

```bash
HEALTH_MONITOR_AUTONOMY=suggest
HEALTH_SUGGEST_BOT=claude          # or codex / antigravity
HEALTH_MONITOR_CHAT_ID=<your-telegram-user-id>
HEALTH_CONTENT_CRAWLER_ENABLED=1
```

### Report format

```
✅ *content-crawler* — GREEN
_All systems nominal_

✅ queue-depth: 12 items queued/pending (12)
✅ failed-items: 0 failed items (0)
✅ stale-workers: 0 items stuck in processing > 30m (0)
✅ signal-feed: signal-feed.json updated 0.2h ago (0.17)
✅ disk-space: 189.3 GB free (189.34)

_2026-06-02T12:18:17.150628_
```

### Adding your own health check script

Any script that exits 0 and prints a JSON `HealthReport` to stdout can plug in via `ExternalPlugin`. The shape:

```json
{
  "pluginName": "my-system",
  "status": "green",
  "checks": [
    { "name": "db-connection", "status": "green", "message": "connected", "value": 12 }
  ],
  "summary": "All systems nominal",
  "timestamp": "2026-06-02T12:00:00.000Z"
}
```

`status` and each check's `status` must be `"green"`, `"amber"`, or `"red"`.

**Python example** (save anywhere, pass path via env var):

```python
#!/usr/bin/env python3
import json
from datetime import datetime

def check_something():
    # your logic here
    return {"name": "my-check", "status": "green", "message": "ok"}

checks = [check_something()]
worst = "red" if any(c["status"] == "red" for c in checks) else \
        "amber" if any(c["status"] == "amber" for c in checks) else "green"

print(json.dumps({
    "pluginName": "my-system",
    "status": worst,
    "checks": checks,
    "summary": "All good" if worst == "green" else "Issues detected",
    "timestamp": datetime.now().isoformat(),
}))
```

Wire it in via env:

```bash
HEALTH_CONTENT_CRAWLER_ENABLED=1
HEALTH_CONTENT_CRAWLER_SCRIPT=/path/to/my_health.py
HEALTH_MONITOR_CHAT_ID=123456789
HEALTH_MONITOR_CADENCE_SECONDS=3600
```

Or register a second plugin directly in `src/index.ts`:

```typescript
healthPlugins.push(new ExternalPlugin({
  name: "my-system",
  command: "python3",
  args: ["/path/to/my_health.py"],
  timeoutMs: 30_000,
}));
```

The content-crawler POC (`scripts/health_check.py` in `~/content-crawler`) checks queue depth, failed items, stale workers, signal-feed freshness, and disk space.

## SOUL.md design

`SOUL.md` is the proposed bridge-level persona contract for all CLI-backed agents.

It should be runtime-injected by the bridge on every turn, including the first prompt after `/reset`, rather than written into `AGENTS.md`, `ANTIGRAVITY.md`, or `CLAUDE.md`.

The intended schema has 9 sections:

1. Identity — who the agent is, not just what it does
2. Values — decision-making when rules do not cover the case
3. Communication Style — tone, length, and formality
4. Expertise — specific tools and domains
5. Boundaries — rules that hold under pressure
6. Workflow — step-by-step process for tasks
7. Tool Usage — when and how to use tools
8. Memory Policy — what persists and what gets wiped
9. Example Interactions — concrete examples of good behaviour

See [`docs/soul.md`](docs/soul.md) for the full design, runtime injection order, reset behaviour, and suggested configuration.

## Systemd deployment

`sudo` is only required for the systemd install step. The installer prompts for each bot token and skips services whose token is left blank.

Systemd deployments require Node 24+. The current motivation is operational as well as compatibility related: direct Codex usage checks against ChatGPT's Codex usage endpoint returned Cloudflare HTML 403 responses under Node 20 on this host, while the same token and headers returned JSON under Node 24.

```bash
sudo bash scripts/install.sh
```

Or copy manually (include only the services you want):

```bash
sudo install -D -m 0644 systemd/agent-bridge-antigravity.service /etc/systemd/system/agent-bridge-antigravity.service
sudo install -D -m 0644 systemd/agent-bridge-codex.service /etc/systemd/system/agent-bridge-codex.service
sudo install -D -m 0644 systemd/agent-bridge-claude.service /etc/systemd/system/agent-bridge-claude.service
sudo install -D -m 0644 systemd/agent-bridge-interactive.service /etc/systemd/system/agent-bridge-interactive.service
sudo install -D -m 0644 systemd/agent-bridge-worker-bot.service /etc/systemd/system/agent-bridge-worker-bot.service
sudo install -D -m 0644 systemd/agent-bridge-health.service /etc/systemd/system/agent-bridge-health.service
sudo install -D -m 0644 systemd/agent-bridge-discord-interactive.service /etc/systemd/system/agent-bridge-discord-interactive.service
sudo install -D -m 0644 systemd/agent-bridge-tmp-cleanup.service /etc/systemd/system/agent-bridge-tmp-cleanup.service
sudo install -D -m 0644 systemd/agent-bridge-tmp-cleanup.timer /etc/systemd/system/agent-bridge-tmp-cleanup.timer
sudo sed -i 's/User=BRIDGE_USER/User='"$USER"'/g' /etc/systemd/system/agent-bridge-*.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-antigravity agent-bridge-codex agent-bridge-tmp-cleanup.timer
```

The repo service templates intentionally use `User=BRIDGE_USER` as an install-time placeholder. If you copy units manually, replace that placeholder with the real runtime account before starting the service; otherwise systemd fails with `status=217/USER`. The cleanup service resolves its executable through `/etc/default/agent-bridge-release` and the immutable `current` release pointer.

### Safe remote restart helper

For restarts triggered from an active bridge session, install the narrow helper
instead of granting passwordless `systemctl`:

```bash
sudo install -D -m 0750 -o root -g root scripts/restart-agent-bridge.sh /usr/local/sbin/restart-agent-bridge
sudo visudo -f /etc/sudoers.d/agent-bridge-restart
```

Sudoers content:

```sudoers
content-crawler ALL=(root) NOPASSWD: /usr/local/sbin/restart-agent-bridge
```

Use:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

The helper waits 5 seconds before restarting the fixed `agent-bridge-*` unit
list, giving the current bot response time to reach Telegram. Do not grant
`NOPASSWD: ALL` or passwordless raw `systemctl`.

Schema-changing production deployments must not use the restart helper. Use the
separately installed, reviewed guarded rollout helper and fixed inventory in
[`docs/GUARDED-ROLLOUT.md`](docs/GUARDED-ROLLOUT.md). Its merge or installation
does not authorize a rollout; production execution requires separate approval.

Only enable optional services after their `/etc/default/agent-bridge-*` file
exists and contains a real token.

Follow logs:

```bash
journalctl -u agent-bridge-antigravity -f
journalctl -u agent-bridge-codex -f
journalctl -u agent-bridge-claude -f
journalctl -u agent-bridge-interactive -f
journalctl -u agent-bridge-worker-bot -f
journalctl -u agent-bridge-discord-interactive -f
journalctl -u agent-bridge-tmp-cleanup -f
```

To update an existing deployment (updates npm packages, Claude Code CLI, and restarts services):

```bash
sudo bash scripts/upgrade.sh
```

### Temporary artifact cleanup

Bot runs, uploads, and test suites all create disposable files and
directories that a normal exit cleans up — but a crash, a hard timeout, a
killed process, or an interrupted `npm test` skips that cleanup and leaves
the artifact behind for good, since nothing else in the codebase ever
revisits it. Left unchecked this accumulates into thousands of stale
directories under `/tmp` and dozens of abandoned `git worktree` checkouts.

`scripts/reap-tmp-artifacts.sh`, run daily by `agent-bridge-tmp-cleanup.timer`,
reclaims these safely:

- **Age-based sweep** of `/tmp/bridge-out/*`, `/tmp/bridge-uploads-*`,
  `/tmp/antigravity-*.log`, and `/tmp/agent-bridge-advisor-*.sock` — anything
  older than `REAP_MAX_AGE_HOURS` (default `24`). Safe because every name
  embeds a UUID/PID/random suffix, so no in-flight run will ever look for an
  old name again.
- **`/tmp/agent-bridge-*` scratch fixtures** (left by `mkdtemp()` calls in the
  test suite) are age-swept the same way, but only if the entry has no
  `.git` — anything that looks like a real git worktree clone is left for
  the worktree pass below instead.
- **Git worktrees**, across the repos listed in `REAP_WORKTREE_REPOS`
  (comma-separated; defaults to `$HOME/agent-bridge`), are only removed —
  along with their local branch — when the branch is already merged into
  the repo's default branch **and** `git status --porcelain` is empty.
  Dirty, unmerged, and detached-HEAD worktrees are always left alone; those
  may be in-progress work that only a human or the
  `finishing-a-development-branch` skill should remove.

Run it by hand any time:

```bash
bash scripts/reap-tmp-artifacts.sh --dry-run   # report only, deletes nothing
bash scripts/reap-tmp-artifacts.sh             # actually reap
```

## Development

```bash
npm test                    # run all tests (vitest)
npm test -- --watch         # watch mode
npm test -- test/cli.test.ts  # single file
```

## Architecture

Agent Bridge OSS is two products on one shared runtime: the **Companion Runtime**
(dedicated, interactive, and Discord bots — conversational, domain-agnostic) and
the **Engineering Worker** (worker bot — software-engineering jobs, Git/PR/CI),
both built on the **Shared Runtime** (SQLite, event store, memory, provider
adapters, CLI management, config, notifications). See
`docs/architecture/03-target-architecture.md` (ADR-008). Service and env var
names below predate the split and are unchanged.

```
Telegram / Discord update
    │
    ├── dedicated bot        → BridgeEngine → active CLI → streamed response
    ├── interactive bot      → /cli preference → BridgeEngine → fallback chain
    ├── worker bot command   → SQLite work_jobs → handler/checkpoint → Telegram report
    └── health service timer → HealthScheduler → Telegram report
```

## State

Each service has its own SQLite database by default (`DB_PATH`, WAL mode). The
main bridge database stores chat sessions and polling state; the worker database
also stores `work_items`, `work_jobs`, `approvals`, `github_links`, and dormant
`role_assignment_revisions` with child `role_assignments` rows.

Schema migration 2 retires the legacy SQLite `prompts` table. Schema migration 3
adds the dormant desired role-assignment tables. Ordinary production services
remain strict and require the guarded rollout helper to upgrade schema-version-2
databases before a schema-3 service starts.

### Guarded production rollout

Schema changes must use the root-owned helper documented in
[`docs/GUARDED-ROLLOUT.md`](docs/GUARDED-ROLLOUT.md). The helper can begin with
the service cohort either running or already stopped, but it always proves
containment before backup and migration. After the post-stop inspection it
removes only stale regular sidecars with a zero-byte WAL; a non-empty WAL or
uncertain sidecar remains a hard failure. It then takes byte-exact backups,
migrates the whole cohort, starts all selected services together, and performs
startup and database validation. Never migrate an individual service database
or bypass this sequence.

| Row key | Value | Purpose |
|---------|-------|---------|
| `<chatId>` | — | Per-chat row; holds session IDs and execution lock |
| `$polling:codex` / `:antigravity` / `:claude` | last update_id | Telegram polling offset per bot |
| `codex` / `antigravity` / `claude` (in `settings`) | model name | Per-bot model override (set via `/models`) |
| `effort:codex` / `effort:antigravity` / `effort:claude` (in `settings`) | effort level | Per-bot effort override (set via `/effort`; Agy stored for parity only) |
| `interactive_cli_preference` | CLI kind | Per-chat active CLI for the unified interactive bot |

Session IDs are stored as columns (`codex_session_id`, `antigravity_session_id`, legacy `gemini_session_id`, `claude_session_id`) on the chat row. The migration adds `antigravity_session_id` and backfills it from legacy `gemini_session_id` automatically on first run.

Discord interactive rows use deterministic numeric aliases of Discord channel
snowflakes. These aliases are stable across restarts; runtime delivery maps the
alias back to the original channel snowflake before calling the Discord REST
API.

Antigravity session capture follows the same durable pattern as Codex, but Agy exposes the ID differently:

1. First turn runs `agy [flags] --print <prompt>` with no `--conversation` flag. Agy requires `--print` immediately before the prompt because it consumes the prompt as its flag value.
2. The bridge extracts the conversation UUID from Agy's explicit log output when available.
3. Because `--log-file` is not always honored by current Agy builds, the bridge also checks `~/.gemini/antigravity-cli/log/*.log` for recent `Created conversation ...` / `Print mode: conversation=...` lines.
4. If logs are not available, it falls back to `~/.gemini/antigravity-cli/cache/last_conversations.json` for the active working directory.
5. Later turns resume explicitly with `agy --conversation <uuid> [flags] --print <prompt>`.

**Antigravity model switching**: Agy does not expose a `--model` CLI flag. The bridge applies model selection (including capacity fallbacks) by writing the chosen model name into `~/.gemini/antigravity-cli/settings.json` before spawning the process. Resetting to the default (via `/models → Reset to Default`) removes the `model` key from that file so Agy falls back to its own default. The selected model is also persisted in the bridge's SQLite `settings` table so it survives service restarts.

**Effort switching**: Codex receives `-c model_reasoning_effort="<level>"`.
Claude receives `--effort <level>`. Agy receives no effort flag; `/effort`
shows an explicit unsupported note so the gap is intentional, not forgotten.
