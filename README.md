# Agent Bridge

Agent Bridge is an open-source runtime for the coding-agent CLIs you already
use. It provides durable Telegram and Discord access to Codex, Claude Code,
Antigravity/Agy, and Kimchi through provider-native sessions and ordinary
Runs.

## Architecture

```text
conversation / workstream
        ↓
recoverable turns and history
        ↓
provider-native session
        ↓
ordinary Run / continuation
        ↓
provider agent + AGENTS.md + Skills + tools/native subagents
        ↓
result / external artifacts
```

Unattended work uses an authenticated durable event receipt or autonomous wake,
then the same ordinary Run and provider-agent path.

Agent Bridge does not run a separate engineering Worker, job dispatcher, role
chain, or Bridge-owned workflow engine. Say `ship it` in a normal provider
conversation. The provider agent follows repository-local instructions and
the installed Skills.

## What it provides

- native provider sessions with restart-safe conversation turns;
- ordinary Run ownership, continuation, cancellation, fencing, and fallback;
- Telegram and Discord delivery with `/stop`, `/reset`, `/cli`, and `/btw`;
- provider-native structured output and final-result delivery;
- health and autonomous event receipts that feed ordinary Runs;
- bounded advisor evidence and shared Skills installation;
- guarded schema and release rollout helpers.

## Services

| Service | Entry point | Surface |
|---|---|---|
| `agent-bridge-codex.service` | `src/index.ts` | Telegram |
| `agent-bridge-antigravity.service` | `src/index.ts` | Telegram |
| `agent-bridge-claude.service` | `src/index.ts` | Telegram |
| `agent-bridge-interactive.service` | `src/index-interactive.ts` | Telegram |
| `agent-bridge-health.service` | `src/index-health.ts` | Telegram |
| `agent-bridge-discord-interactive.service` | `src/index-discord-interactive.ts` | Discord |

## Setup

Requirements are Node 24+, npm, authenticated provider CLIs, and the tokens
for the surfaces you enable. Install dependencies with:

```bash
npm install
```

Copy the relevant `.env.*.example` file, set the provider command and token,
then run the matching entry point. The systemd installer and guarded rollout
helpers are documented in [docs/INITIAL-INSTALL.md](docs/INITIAL-INSTALL.md)
and [docs/GUARDED-ROLLOUT.md](docs/GUARDED-ROLLOUT.md).

The interactive fallback order is configured with
`INTERACTIVE_CLI_CHAIN`. Explicit `AGENT_BRIDGE_SKILLS` overrides keep their
existing behaviour.

## Data compatibility

Schema version 9 removes the obsolete Engineering Worker tables, including
`work_items`, `work_jobs`, approvals, GitHub links, feature plans, and
role-assignment rows. The migration accepts populated legacy tables because
their data is obsolete by design. Active runtime state remains intact.

## Development

```bash
npm test
npm run typecheck
npm run cleanup:check
```

See [docs/architecture/overview.md](docs/architecture/overview.md) and
[docs/README.md](docs/README.md) for the current documentation map. Research
and archive documents are historical context and do not define runtime
behaviour.
