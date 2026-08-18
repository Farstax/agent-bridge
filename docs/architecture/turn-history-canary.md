---
status: authoritative
type: architecture
authority: temporary-override
implementation_status: implemented
last_validated_against: issue-477
---

# Turn-history continuity canary

Issue #477 adds a temporary rollback gate around the legacy compact-summary and project-memory continuity paths.

This document overrides `docs/architecture/memory-and-handoff.md` only while `BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED=false`. The existing memory-and-handoff architecture remains the rollback behavior while the flag is unset or `true`.

## Rollout flag

`BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED` defaults to enabled. Only an explicit value of `false` activates turn-history mode.

No schema migration or data deletion occurs when the flag changes. Existing `conversation_summaries` and `project_memories` rows remain on disk so rollback is one configuration change.

## Turn-history mode

When the flag is `false`:

- provider-native resume remains the primary same-provider continuity path;
- a fresh provider receives bounded exact `conversation_turns`, not a generated compact summary;
- the default fresh-context budget is 24,000 characters; an explicit `BRIDGE_CONTEXT_MAX_CHARS` still wins;
- manual, pre-seed, and capacity-fallback compaction do not call a provider or write a summary;
- compact memory promotion and hidden assistant memory-sidecar writes do not persist project memories;
- ordinary provider context does not expose stored project-memory hints/results;
- `agent-bridge-context --recent 20` and `--search <query>` remain available for older exact-turn retrieval;
- legacy summary and project-memory helper reads report that legacy memory is disabled;
- `/compact` reports disabled and `/context` does not suggest compaction;
- `/reset` retains its existing semantics and clears the scoped conversation turns and summaries.

The lane, fencing, fallback, restart, and provider-session ownership rules are unchanged.

## Rollback

Set `BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED=true` (or remove the explicit `false`) and restart through the normal deployment path. Stored summaries and project memories become available again because the canary never migrates or deletes them.

## Deletion gate

Do not delete the legacy summary/compaction/project-memory paths as part of issue #477. After turn-history mode has become the qualified default and has been observed for at least one release without rollback, open a separate deletion issue. That issue owns removing the temporary flag and any legacy code or data structures that are no longer needed.
