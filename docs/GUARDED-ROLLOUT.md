# Guarded production deployment

The only operator-facing deployment path is the root-owned `agent-bridge-deploy`
deployer. The old stage/activate/restore/authorization/acceptance commands are
private implementation details and are not an alternative runbook.

## Three inputs

```bash
sudo agent-bridge-deploy \
  --release agent-bridge-<commit>.tar.gz \
  --approval production-approval.json
```

The release archive is the single release identity. It contains the runtime,
dependencies, migration code, exact commit/tree manifest, and embedded
`qualification-evidence.json`. The approval is mode `0600` and binds only
environment, target commit, release SHA-256, approval reference and expiry.

The deployer computes the archive SHA itself, validates the manifest and every
payload hash/size/type/symlink, checks the embedded qualification metadata, and
compares the result with the approval. It does not accept component-helper
hashes, an external evidence file, a secondary bundle, or legacy identity flags.

## Installation

Install the stable deployer and its private implementation primitives as
root-owned files. Operators invoke only the first command:

```bash
sudo install -D -m 0750 -o root -g root scripts/agent-bridge-deploy.py /usr/local/sbin/agent-bridge-deploy
```

The installation package provisions the private primitives and root-owned
configuration alongside the deployer; they are not separate operator inputs.

The private helpers are not normal operator commands. Their paths, service
inventory and database inventory remain root-owned and fixed in configuration.
The deployer is the sole owner of staging, preflight, containment, backup,
migration, pointer activation, restart, acceptance and rollback sequencing.

## Safety sequence

1. Validate the archive and minimal approval before mutation.
2. Stage into an immutable commit-addressed directory and verify the manifest.
3. Validate effective systemd safety properties: exact units, fragment paths,
   drop-ins, environment files, active states, process containment and cgroups.
4. Acquire the exclusive rollout lock and capture durable preflight evidence.
5. Prove containment before touching databases or the current pointer.
6. Checkpoint WALs, verify integrity/foreign keys/schema/queue/claim/lock state,
   and create byte-exact verified backups.
7. Migrate and validate the full database cohort.
8. Atomically switch the `current` pointer, restart services, and run bounded
   acceptance and stability checks.
9. Write durable `deployment-result.json` and supporting evidence.

Automatic rollback is permitted only for a proven pre-start failure with
verified containment and verified backups. Any ambiguity, possible post-start
write, containment failure, migration failure without a proven restore, or
acceptance failure is fail-closed and requires manual review. Queues, claims,
runs, events and locks are never deleted or silently replayed.

## Supersession

The former multi-file workflow requiring separate artifact/evidence inputs,
component-helper pins, `release-stage`, `release-activate`, `rollout-restore`,
authorization and acceptance invocations is superseded. Do not use those
commands directly or maintain them as a second operational path.
