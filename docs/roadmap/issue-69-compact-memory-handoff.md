---
status: completed
type: roadmap
authority: historical
implementation_status: implemented
last_validated_against: issue-69
---

# Issue #69 Completion Summary: Compact Memory and CLI Handoff

Issue #69 is complete.

This roadmap originally tracked the compact-first memory and CLI handoff architecture. The implementation landed through a sequence of small, test-first PRs and the remaining human-facing memory command scope was deliberately removed: durable memory is an agent-facing substrate, while operators get health diagnostics through `/context`.

## Completed Implementation

| PR | Scope | Status |
|---|---|---|
| #71 | Characterisation tests + post-turn extractor removal | merged |
| #72 | Structured compact JSON output + companion/engineering profiles | merged |
| #73 | Shared `compactConversation()` service + memory promotion + non-destructive failure | merged |
| #74 | Latest-N context retrieval fix | merged |
| #75 | One-time handoff state primitive | merged |
| #76 | Manual switch + fallback handoff wiring | merged |
| #79 | Minimal pre-seed compaction before fresh handoff seeds | merged |
| #80 | Operator diagnostics via `/context`; no human-facing `/memory` command | merged |

## Final Architecture

Agent Bridge now uses a compact-first memory model:

- post-turn automatic extraction was removed;
- compaction is the deliberate durable-memory distillation point;
- compaction stores structured summaries and promotes validated memory candidates;
- manual CLI switch and fallback use one shared handoff path;
- fallback can compact before provider handoff without blocking if compaction fails;
- prompt context uses the latest compact summary plus latest recent-turn tail;
- compaction processes the full un-compacted backlog independently of the prompt-context cap;
- fresh provider invocations receive one bounded seed and resumed invocations rely on native CLI session continuity;
- pre-seed compaction can run before oversized fresh handoff seeds via `BRIDGE_PRESEED_COMPACT_MODE=auto`.

## Operator Boundary

PR #80 finalized the operator surface:

- `/context` reports context and memory health: injection policy, pre-seed compact mode/threshold, uncompacted turn/char counts, and memory count;
- no Telegram-facing `/memory`, `/memory <query>`, or `/memory forget` command was added;
- persistent memory remains agent-facing and is consumed by subprocess CLIs through `agent-bridge-context --memory*`.

## Platform Defaults

Recommended platform-managed deployment defaults:

```text
BRIDGE_PRESEED_COMPACT_MODE=auto
BRIDGE_PRESEED_COMPACT_CHARS=30000
```

OSS/self-hosted default behaviour remains compatible:

```text
BRIDGE_PRESEED_COMPACT_MODE=off
```

## Follow-Up Items

The following are no longer blockers for Issue #69 and should be tracked separately if needed:

1. **Agent-facing memory correction/forget mechanics** if automatic promotion proves noisy.
2. **Optional one-time context policy for individual non-companion CLI bots.** The interactive/companion bot is the required provider-switching/fallback case; individual bots may continue to rely primarily on native CLI session continuity.

## Closure Criteria

All original core acceptance criteria are implemented:

- post-turn extractor removed;
- compaction produces summaries and durable memory candidates;
- companion and engineering compact profiles exist;
- manual CLI switch and fallback share a handoff path;
- normal `/compact` and fallback compaction share the same core service;
- compaction failure is non-destructive;
- same-session continuation no longer requires repeated full context injection under `handoff_once`;
- latest-N context retrieval is fixed;
- full backlog compaction uses chunking;
- `/context` provides operator diagnostics without exposing memory contents.
