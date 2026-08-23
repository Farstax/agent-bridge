---
status: authoritative
type: architecture
authority: temporary-override
implementation_status: implemented
last_validated_against: issue-539
---

# Turn-history continuity canary

Issue #477 added a temporary rollback gate around the legacy compact-summary and project-memory continuity paths. Issue #539 makes turn-history continuity the default while retaining that rollback gate.

This document overrides `docs/architecture/memory-and-handoff.md` while `BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED` is unset or `false`. The existing memory-and-handoff architecture remains available only as explicit rollback behavior when the flag is `true`.

## Rollout flag

`BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED` defaults to disabled. Only an explicit value of `true` restores legacy generated-summary/project-memory behavior.

No schema migration or data deletion occurs when the flag changes. Existing `conversation_summaries` and `project_memories` rows remain on disk so rollback is one configuration change.

## Turn-history mode

When the flag is unset or `false`:

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

Set `BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED=true` and restart through the normal deployment path. Stored summaries and project memories become available again because the canary never migrates or deletes them. Remove the setting or set it to `false` to return to turn-history mode.

## Deletion gate

Do not delete the legacy summary/compaction/project-memory paths as part of issue #539. After turn-history mode has been observed as the qualified default for at least one release without rollback, open a separate deletion issue. That issue owns removing the temporary flag and any legacy code or data structures that are no longer needed.
