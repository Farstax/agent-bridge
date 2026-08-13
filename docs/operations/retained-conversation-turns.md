---
status: authoritative
type: operations
authority: canonical
implementation_status: implemented
last_validated_against: 9e123da
---

# Retained conversation turns

This is the operator policy for the append-only `conversation_turns` behavior
delivered by #349/#354. It is the current operational authority for retained
conversation evidence; older product/reference text describing summary-gated
pruning predates #354.

## Policy

- Rows in `conversation_turns` retained by #354 are the source evidence for a
  conversation. `conversation_summaries` are bounded, replaceable handoff
  caches, not a replacement for that evidence.
- Normal compaction and database startup/open do not prune retained turns.
  Normal operation does not automatically delete them. `/reset` is the
  explicit user-controlled full-history deletion path for the current
  conversation scope; it clears that scope's provider session, pending work,
  retained turns, and summaries without affecting other conversations.
- There is no age-based retention period. Storage capacity pressure is the
  trigger for operator intervention; this policy does not add automatic
  pruning or a retention daemon.
- Cleanup, if ever required, is an explicit operator action. Before any
  destructive cleanup, stop or otherwise quiesce the affected service as
  appropriate, preserve a verified recoverable copy of the affected database
  and evidence, and record which database and rows are in scope. The on-call
  Agent Bridge operator owns this decision and records the affected paths and
  verification in the incident/release evidence. Cleanup must not leave a
  summary as the only surviving evidence.
- After cleanup, verify SQLite integrity (`quick_check` and
  `foreign_key_check`) and service health before treating the operation as
  complete. If a safe, documented cleanup procedure cannot be established,
  do not improvise database mutation; raise a narrowly scoped follow-up issue.

## Database and monitoring

The conversation database is the file selected by each service's `DB_PATH`.
On the current host the active interactive and worker databases are:

```text
/home/content-crawler/runtime/agent-bridge/interactive/bridge.sqlite
/home/content-crawler/runtime/agent-bridge/worker/bridge.sqlite
```

The current provider-specific services are configured to use the shared

```text
/home/content-crawler/agent-bridge/.data/bridge.sqlite
```

file. A fresh installation may instead use the installer state root
`/var/lib/agent-bridge/<service>/bridge.sqlite`; `DB_PATH` is authoritative in
all cases. Before operating on a database, inventory every selected service by
reading its systemd `EnvironmentFile` and `DB_PATH`, resolve the path, and
check the filesystem with `df -P`. Include any configured `HEALTH_DB_PATH` in
the inventory, while treating the health-role database as separate health
state unless its schema contains conversation evidence. These paths are on
`/` on the current host; the health check for `/` therefore covers the current
conversation data.

The existing health `ServerPlugin` is the accepted #369 monitoring mechanism.
On this host it is enabled by `agent-bridge-health.service` with
`HEALTH_MONITOR_ENABLED=true`, the default non-disabled
`HEALTH_SERVER_MONITOR_ENABLED` setting, and a configured operator Telegram
chat. Before relying on an alert after a service/configuration change, verify
those settings and the selected database mounts. The plugin reports:

- `disk-space` for `/`: amber below 2 GB free, red below 0.5 GB free;
- `disk-space-home` for `$HOME` (and `disk-space-tmp` for `/tmp`) with the
  same amber/red thresholds.

The health scheduler persists the report and sends every non-green report to
the configured health Telegram chat. A red transition may additionally enter
the existing authenticated health-event path when configured. The operator
response is: treat amber as a prompt to inspect capacity and plan action;
treat red as an urgent capacity incident, protect the database/evidence,
quiesce affected services if required, and perform only an explicitly
verified recovery or cleanup procedure. This policy adds no second monitor,
history store, scheduler, or health table.

## Rollout and rollback gate

The retained-turn behavior from #349/#354 must not be deployed to production
until this policy is approved and discoverable, the existing health monitoring
coverage/alert path is evidenced, and rollback qualification is recorded.
This is a sequencing prerequisite for normal release handling, not a runtime
or GitHub-issue-aware deployment gate. The release owner records this policy,
the path/mount inventory, health evidence, and rollback evidence in the normal
release qualification record before approving that subsequent release. #369
does not change guarded rollout scripts, deployment approval logic, release
artifacts, or deployment state.

Reverting the #354 code does not itself delete rows already retained in
`conversation_turns`. Code rollback and data cleanup are separate actions.
The qualification evidence is the existing #354/current test coverage:

- `test/compactConversation.test.ts` proves successful compaction retains
  source turns and failed compaction leaves retained turns unchanged;
- `test/db.test.ts` proves reopening an existing database retains covered
  turns and keeps them out of bounded context;
- reset regression coverage proves `/reset` clears retained turns and summaries
  only for the originating conversation scope while leaving other conversation
  evidence untouched;
- the existing guarded rollout backup/integrity checks provide recoverable
  database copies, file/hash restoration, schema, and post-restore
  verification; the #354 reopen test supplies the retained-row semantic
  evidence. Together these qualify recovery without claiming a new semantic
  backup/restore test.

No production deployment or cleanup is part of #369.
