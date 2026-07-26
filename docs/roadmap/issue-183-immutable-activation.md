# Issue #183 — immutable activation closeout slice

This document records the non-production activation boundary implemented for
Issue #183. It does not authorize deployment or change live services,
databases, queues, or workspaces.

## Recovery-readiness gate

Issue #193 owns stale runtime reconciliation. A `running` row is audit state,
not proof of liveness. Reconciliation may fail a run only after an explicit
age cutoff, proven process containment, absent execution locks for the run and
chat, and zero claimed pending messages. Ambiguous ownership remains untouched.
Stale lock release requires the same containment proof plus an explicit stale
lock observation. Run, event, queue, and pending-message rows are never
deleted, replayed, discarded, or rewritten. Every successful mutation records
before/after evidence; an interruption rolls back the transaction.

The current `10ccfe…` release is not an automatic rollback baseline, and the
staged `3958013…` release is not accepted as one until schema, queue, claim,
lock, and delivery compatibility are independently proven. The interim design
therefore has no automatic rollback baseline. The linear path is:

```text
reconcile stale runtime state
  -> build fresh immutable baseline
  -> validate artifact and copied database cohort offline
  -> independent approval
  -> separately authorized guarded rollout
```

Schema version 4 owns the `reconciliation_audit` table; ordinary startup no
longer creates reconciliation schema objects. `scripts/offline-baseline-validate.py` and the manual
`offline-baseline-validation.yml` workflow are fixture-only. They reject
production-looking database roots, download named non-production artifact and
fixture bundles, compute the checked-out builder and helper identities, require
exact artifact identities and strict manifest equality, open copied SQLite
files read-only, and emit durable evidence. Their rollback simulation mutates
and restores only temporary fixture copies and switches only a temporary
pointer. They do not stage artifacts or access live databases.

## State machine

```text
PRECHECK_STARTED -> PREFLIGHT -> CONTAINED -> WAL_DRAINED -> BACKED_UP -> MIGRATED
  -> POINTER_SWITCHED -> SERVICES_STARTING -> ACCEPTED -> COMPLETE

pre-start failure -> DATABASES_RESTORED -> POINTER_ROLLBACK_STARTED
  -> POINTER_ROLLED_BACK -> PREVIOUS_RELEASE_STARTING
  -> PREVIOUS_RELEASE_ACCEPTED -> FAILED_RESTORED

start-attempt or ambiguous failure -> stop and contain ->
  preserve new state/evidence -> STOPPED_PRESERVED / manual review
```

## Guarantees

- Release mode never switches or resets a live Git checkout.
- `current` is published by the atomic release activation helper only after
  containment, WAL checkpointing, backup, migration, and validation.
- A proven pre-start failure restores the byte-verified database cohort,
  reactivates the previous immutable release, and verifies service health.
- If terminal recovery evidence cannot be recorded after that restart, the
  previous release is re-contained and the outcome remains
  `RESTORE_INCOMPLETE`; it is never reported as `FAILED_RESTORED`.
- Any start attempt, uncertain containment, pointer ambiguity, or possible
  write acceptance remains fail-closed and requires manual review.
- SQLite WALs are drained with `wal_checkpoint(TRUNCATE)`; rollout code does
  not delete a non-empty WAL as a substitute for checkpointing.
- Queue counts and resolving-unit evidence remain in the database evidence;
  rollout does not discard, replay, or rewrite pending queue rows.

## Evidence

Each rollout artifact records containment, preflight/stopped/checkpoint,
backup, migration, validation, pointer-switch, startup, and post-start
evidence. JSON evidence receives SHA-256 sidecar manifests. Immutable release
evidence binds the target and previous commits to the rollout-helper SHA-256.

## Remaining operational gate

Production installation, deployment, service restart, live WAL/database
mutation, and Telegram acceptance verification remain separate approved
operations. They must be performed only after human review of the exact
artifact, current pointer, database inventory, rollback evidence, and service
health plan.
