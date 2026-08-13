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
  Normal operation does not automatically delete them. `/reset` remains the
  existing session-reset behavior and is unchanged by this policy.
- There is no age-based retention period. Storage capacity pressure is the
  trigger for operator intervention; this policy does not add automatic
  pruning or a retention daemon.
- Cleanup, if ever required, is an explicit operator action. Before any
  destructive cleanup, stop or otherwise quiesce the affected service as
  appropriate, preserve a verified recoverable copy of the affected database
  and evidence, and record which database and rows are in scope. Cleanup must
  not leave a summary as the only surviving evidence.
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

The provider-specific services may use their configured `DB_PATH` (the
development/default path is `<project>/.data/bridge.sqlite`). Check the
service environment before operating on a file. These paths are on `/` on the
current host; the health check for `/` therefore covers the conversation data.

The existing health `ServerPlugin` is the accepted #369 monitoring mechanism.
It reports:

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
or GitHub-issue-aware deployment gate. #369 does not change guarded rollout
scripts, deployment approval logic, release artifacts, or deployment state.

Reverting the #354 code does not itself delete rows already retained in
`conversation_turns`. Code rollback and data cleanup are separate actions.
The qualification evidence is the existing #354/current test coverage:

- `test/compactConversation.test.ts` proves successful compaction retains
  source turns and failed compaction leaves retained turns unchanged;
- `test/db.test.ts` proves reopening an existing database retains covered
  turns and keeps them out of bounded context;
- `test/engine.test.ts` proves `/reset` behavior remains unchanged and keeps
  the existing conversation evidence;
- the existing guarded rollout backup/integrity checks provide recoverable
  database copies and post-restore verification.

No production deployment or cleanup is part of #369.
