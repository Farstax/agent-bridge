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

For a production run, the public command automatically continues inside a
root-owned transient systemd service before it validates or stops any Agent
Bridge unit. This keeps the deployment worker outside the seven service
cgroups, so stopping the bridge that launched the command cannot terminate the
rollout itself. Operators still invoke only `agent-bridge-deploy`; do not add a
manual `systemd-run` wrapper or another deployment path.

## Installation

Install the stable deployer and its private implementation primitives as
root-owned files. Operators invoke only the first installed command:

```bash
sudo install -D -m 0750 -o root -g root scripts/agent-bridge-deploy.py /usr/local/sbin/agent-bridge-deploy
sudo install -D -m 0750 -o root -g root scripts/rollout-agent-bridge.sh /usr/local/sbin/rollout-agent-bridge
sudo install -D -m 0750 -o root -g root scripts/release-stage.py /usr/local/libexec/agent-bridge-release-stage
sudo install -D -m 0750 -o root -g root scripts/release-activate.py /usr/local/libexec/agent-bridge-release-activate
sudo install -D -m 0750 -o root -g root scripts/rollout-restore.py /usr/local/libexec/agent-bridge-rollout-restore
sudo install -D -m 0750 -o root -g root scripts/rollout-authorization.py /usr/local/libexec/agent-bridge-rollout-authorization.py
sudo install -D -m 0750 -o root -g root scripts/rollout-acceptance.py /usr/local/libexec/agent-bridge-rollout-acceptance.py
```

Install `/etc/agent-bridge/rollout.conf` root-owned and non-writable by
group/other. The private primitives are deployed at these fixed paths and are
not granted sudoers access or treated as operator commands; remove any older
sudoers entries that exposed stage, activate, restore, authorization or
acceptance directly. Only `agent-bridge-deploy` is granted the production
sudoers entry.

The private helpers are not normal operator commands. Their paths, service
inventory and database inventory remain root-owned and fixed in configuration.
The deployer is the sole owner of staging, preflight, containment, backup,
migration, pointer activation, restart, acceptance and rollback sequencing.

## Safety sequence

1. Move the production worker into its dedicated transient systemd service.
2. Validate the archive and minimal approval before mutation.
3. Stage into an immutable commit-addressed directory and verify the manifest.
4. Validate effective systemd safety properties: exact units, fragment paths,
   drop-ins, environment files, active states, process containment and cgroups.
5. Acquire the exclusive rollout lock and capture durable preflight evidence.
6. Prove containment before touching databases or the current pointer.
7. Checkpoint WALs, verify integrity/foreign keys/schema/queue/claim/lock state,
   and create byte-exact verified backups.
8. Migrate and validate the full database cohort.
9. Atomically switch the `current` pointer, restart services, and run bounded
   acceptance and stability checks.
10. Write durable `deployment-result.json` and supporting evidence.

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
