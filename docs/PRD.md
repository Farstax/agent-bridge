# Agent Bridge product requirements

## Product boundary

Agent Bridge provides remote, durable access to provider-native coding-agent
CLIs through Telegram and Discord. It keeps conversation turns, native
provider sessions, ordinary Runs, continuation, cancellation, fallback, and
safe result delivery.

Engineering delegation follows repository-local `AGENTS.md` and installed
Skills. A user aligns with the agent, then says `ship it`. The provider agent
performs the repository work, tests, review, CI, merge, and cleanup allowed by
the local instructions and available tools.

```text
conversation → turns/history → native session → Run/continuation
→ provider agent + AGENTS.md + Skills + tools/native subagents → result
```

Unattended health and autonomous goal work uses an authenticated durable
receipt or wake followed by an ordinary owning Run. It uses the same provider
agent path. The receipt is not a job queue.

## Runtime requirements

- Provider adapters decide native invocation and session behaviour.
- The supervisor remains provider-agnostic.
- SQLite stores recoverable turns, sessions, Runs, locks, receipts, memories,
  and audit evidence.
- Cancellation and execution fences prevent late provider effects.
- Final provider results remain authoritative for persistence and delivery.
- Install and upgrade paths expose only active Telegram, Discord, health, and
  cleanup services.

Schema version 9 removes the obsolete Engineering Worker tables. Current
runtime code does not create, claim, or execute those records.

## Non-goals

Agent Bridge does not provide a Bridge-owned engineering workflow engine,
Worker bot, role chain, durable Task model, or generic orchestration layer.
