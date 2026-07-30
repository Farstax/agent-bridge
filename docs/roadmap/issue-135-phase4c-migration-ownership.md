# Issue #135 Phase 4C — historical migration ownership record

> **Historical record, not an operator runbook.** The current production process
> is defined by [`AGENTS.md`](../../AGENTS.md),
> [`docs/GUARDED-ROLLOUT.md`](../GUARDED-ROLLOUT.md), and the executable
> `agent-bridge-deploy` contract. Those sources take precedence over this file.

Phase 4C is complete, including its original production deployment. This file
retains the design outcome and closeout evidence without preserving superseded
procedural gates as current instructions.

## Implemented outcome

Phase 4C established these durable boundaries:

- Ordinary production services open only current-schema databases and fail
  closed when a migration or bootstrap is required.
- The guarded deployer is the sole production migration owner; ordinary service
  startup never advances a database schema.
- Seven production services resolve to a fixed five-database cohort. Canonical
  paths are deduplicated before backup or migration.
- Production migration runs only after all selected services are contained.
- WAL checkpointing, integrity/foreign-key checks and complete verified backups
  precede migration.
- The full cohort is migrated, lifecycle ownership is reconciled transactionally
  after migration, and every database is validated before activation.
- Pre-start failures recover to the unchanged previous release or restore the
  complete verified cohort. Post-start failures remain contained for manual
  review; databases are not automatically restored after services may have
  accepted writes.
- Rollback is whole-cohort restoration plus the previous release, never a live
  schema downgrade.

## Current approval boundary

Normal delivery uses at most two human approvals:

1. one exact-head merge approval; and
2. one exact-release deployment approval, only when production deployment is
   requested.

The deployment approval binds environment, target commit, release SHA-256,
approval reference and expiry. It authorises the complete guarded command:
archive validation, immutable staging, preflight, containment, backup,
migration, reconciliation, pointer activation, restart and acceptance.

Artifact generation, archive validation, read-only inspection, offline fixture
work and evidence publication are verification activities, not separate
approval gates. The deployer performs its own preflight and backup sequence; a
manual preflight backup, manual database inspection, helper-by-helper approval,
per-phase sign-off or separate acceptance approval is not part of the normal
path.

Manual review is required only when an approved identity changes, approval scope
or expiry is invalid, containment/restoration cannot be proven, an integrity or
provenance invariant fails, or a failure occurs after services may have accepted
writes.

## Current operator path

```bash
sudo agent-bridge-deploy \
  --release agent-bridge-<commit>.tar.gz \
  --approval production-approval.json
```

Operators do not directly invoke `rollout-agent-bridge`, `release-stage`,
`release-activate`, `rollout-restore`, `rollout-authorization` or
`rollout-acceptance`. They are private deployer internals.

On success, rely on the deployer's durable `deployment-result.json`, exact
pointer identity, service stability, database validation and cleared sentinel.
On a stopped failure, follow the recorded deployment evidence and the current
recovery behavior in `docs/GUARDED-ROLLOUT.md`; do not invent a parallel manual
workflow.

## Historical closeout

The original Phase 4C rollout completed at deployed head
`8c74c3f78f3742297cf4346ec3458124d9d64749`; PR #184 later merged the unchanged
tree as `f3c40327763c4b3232a86e0e6e073545bdbd84cf`, so no second rollout was
required.

Historical evidence was recorded under:

```text
/var/log/agent-bridge-rollouts/20260721T114637Z-8c74c3f78f3742297cf4346ec3458124d9d64749
```

That run proved seven services active, five databases integrity-valid at the
current schema, WAL checkpointing before backup, verified backup evidence,
clean startup and no remaining rollout sentinel.

## Superseded material

Git history and Issue #135 preserve the detailed proposal, test matrix and early
state-machine design. The following are intentionally no longer presented here
as current requirements:

- direct guarded-helper invocation or working-tree checkout deployment;
- manual preflight backup and database inspection as mandatory gates;
- separate stage, activate, restore, authorization or acceptance workflows;
- approval documents containing individual helper hashes or external evidence
  bundles;
- live provider-process, run, claim or lock ownership classification as a
  preflight blocker;
- repeated approval after each successful rollout phase; and
- historical before/after run, event, lock or delivery equality as acceptance
  gates.

Refs #135.
