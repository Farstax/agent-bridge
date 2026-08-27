---
status: authoritative
type: operations
authority: canonical
implementation_status: implemented
last_validated_against: issue-544
---

# Retained conversation turns

This is the operator policy for retained `conversation_turns` evidence.

## Policy

- `conversation_turns` are the Agent Bridge source evidence for a conversation.
- Provider-native sessions remain the primary same-provider continuity path.
- A fresh provider receives bounded exact retained turns. Older exact turns remain available through `agent-bridge-context --recent` and `--search`.
- Supported runtime paths do not generate compact summaries, run manual/pre-seed/fallback compaction, or promote project memories.
- Historical `conversation_summaries` and `project_memories` rows may remain in existing databases for compatibility and audit. They are not a supported continuity input and are not regenerated.
- Normal operation does not automatically delete retained turns. `/reset` is the explicit user-controlled full-history deletion path for the current conversation scope; it clears that scope's provider session, pending work, retained turns, and historical summaries without affecting other conversations.
- There is no age-based retention period. Storage capacity pressure is the trigger for operator intervention; this policy does not add automatic pruning or a retention daemon.
- Cleanup, if ever required, is an explicit operator action. Before destructive cleanup, quiesce the affected service as appropriate, preserve a verified recoverable copy of the affected database and evidence, and record which database and rows are in scope.
- After cleanup, verify SQLite integrity (`quick_check` and `foreign_key_check`) and service health. If a safe documented cleanup procedure cannot be established, do not improvise database mutation; raise a narrowly scoped follow-up issue.

## Database and monitoring

The conversation database is the file selected by each service's `DB_PATH`; that configured path is authoritative. Before operating on a database, inventory every selected service by reading its systemd `EnvironmentFile` and `DB_PATH`, resolve the path, and check the backing filesystem with `df -P`.

Include any configured `HEALTH_DB_PATH` in the inventory while treating the health-role database as separate health state unless its schema contains conversation evidence.

The existing health `ServerPlugin` is the accepted capacity-monitoring mechanism. Before relying on an alert after a service or configuration change, verify the health monitor is enabled, the operator notification destination is configured, and the filesystem containing each selected conversation database is covered.

The operator response is to treat amber disk-space state as a prompt to inspect capacity and plan action, and red as an urgent capacity incident. Protect the database and retained evidence first; perform only an explicitly verified recovery or cleanup procedure.

## Recovery evidence

Code rollback and data cleanup are separate actions. A code rollback must not be treated as permission to delete retained rows.

Current recovery evidence should cover:

- reopening an existing database without losing retained conversation turns;
- `/reset` clearing retained turns and historical summaries only for the originating conversation scope;
- guarded rollout backup/integrity checks providing recoverable database copies, file/hash restoration, schema validation, and post-restore verification.

The removal of legacy compaction/project-memory execution in #544 does not perform a destructive schema migration or delete historical summary/memory rows.


## Explicit cross-conversation search

Search stays conversation-scoped by default. When the runtime has exactly one authenticated owner, it exposes an explicit `--scope owner` search. Owner scope is derived by the runtime from the authenticated surface allowlist, not accepted from prompt text, and matches only turns written with that durable owner key. Results retain their canonical surface, conversation key, timestamp, and adjacent exact turns. Legacy pre-migration rows remain available to conversation scope but are never widened into owner scope. Project scope is intentionally not implemented until Agent Bridge has a concrete project identity.
