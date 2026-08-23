# Agent Bridge

Agent Bridge is an open-source runtime for the coding-agent CLIs you already
use. It provides durable Telegram and Discord access to Codex, Claude Code,
Antigravity/Agy, and Grok Build through provider-native sessions and ordinary Runs.

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

All Telegram conversation services use the same production runtime. The three
established dedicated provider units set `BRIDGE_PROVIDER_LOCK` and keep their
existing provider-specific tokens and persistent databases. The interactive
unit leaves the lock unset so `/cli` switching and configured provider fallback
remain available. Managed Grok uses that interactive unit rather than widening
the guarded systemd unit inventory.

| Service | Entry point | Surface |
|---|---|---|
| `agent-bridge-codex.service` | `src/index-interactive.ts` | Telegram, locked to Codex |
| `agent-bridge-antigravity.service` | `src/index-interactive.ts` | Telegram, locked to Antigravity |
| `agent-bridge-claude.service` | `src/index-interactive.ts` | Telegram, locked to Claude |
| `agent-bridge-interactive.service` | `src/index-interactive.ts` | Telegram, switchable, including Grok |
| `agent-bridge-health.service` | `src/index-health.ts` | Telegram |
| `agent-bridge-discord-interactive.service` | `src/index-discord-interactive.ts` | Discord |

## Setup

Requirements are Node 24+, npm, authenticated provider CLIs, and the tokens
for the surfaces you enable. Install dependencies with:

```bash
npm install
```

Copy the relevant `.env.*.example` file, set the provider command and token,
then run the matching service or `npm start`. The systemd installer and guarded
rollout helpers are documented in [docs/INITIAL-INSTALL.md](docs/INITIAL-INSTALL.md)
and [docs/GUARDED-ROLLOUT.md](docs/GUARDED-ROLLOUT.md).

The interactive fallback order is configured with `INTERACTIVE_CLI_CHAIN`.
When unset, the default is `codex,claude,grok,antigravity`. The runtime also
accepts `BRIDGE_PROVIDER_LOCK=codex|claude|antigravity|grok` for fixed-provider
custom or dedicated deployments. The shipped managed dedicated units remain
Codex, Claude, and Antigravity; managed Grok uses
`agent-bridge-interactive.service`. Explicit `AGENT_BRIDGE_SKILLS` overrides
keep their existing behaviour.

Grok participates when it is authenticated, using the runtime user's native
Grok credentials or `XAI_API_KEY`. Qualification remains available for upgrade,
health, doctor, and diagnostics. Missing, stale, or degraded qualification
evidence does not block routing; a current deterministic `overall: fail` record
for the installed Grok version does. For a managed host, use `GROK_COMMAND` to
pin the executable path; the installer propagates `GROK_COMMAND`,
`GROK_MODEL_PREFERENCE`, `GROK_EFFORT`, and `GROK_PROJECT_DIR`.

Run an explicit diagnostic qualification when needed with:

```bash
npm run qualify:provider -- --provider grok
```

## Data compatibility

Schema version 9 removes the obsolete Engineering Worker tables, including
`work_items`, `work_jobs`, approvals, GitHub links, feature plans, and
role-assignment rows. The migration accepts populated legacy tables because
their data is obsolete by design. Active runtime state remains intact.

Schema version 10 adds Grok Build session identity columns.

Provider-lock convergence does not move or change existing dedicated provider
databases. Locked units keep the `shared` database role; the switchable
interactive unit keeps the `interactive` role.

## Open-source licence and commercial boundary

Agent Bridge material in this repository is licensed under the
[Apache License 2.0](LICENSE), except for third-party material that carries its
own licence. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled
third-party attribution.

This licence applies to the public `agent-bridge` repository only. It does not
license `agent-bridge-platform`, the Farstax hosted control plane, managed
hosting or provisioning services, commercial operations, or other proprietary
Platform assets. The runtime/platform responsibility boundary is documented in
[docs/architecture/platform-boundary.md](docs/architecture/platform-boundary.md).

The licence decision and rationale are recorded in
[ADR-004](docs/adr/ADR-004-oss-license.md).
