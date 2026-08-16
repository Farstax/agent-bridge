# Guarded production deployment

The only operator-facing deployment path is the root-owned `agent-bridge-deploy`
deployer. The old stage/activate/restore/authorization/acceptance commands are
private implementation details and are not an alternative runbook.

## Deployment inputs

```bash
sudo agent-bridge-deploy \
  --release agent-bridge-<commit>.tar.gz \
  --approval production-approval.json
```

An authenticated repository-owner request can authorize the same operation
without a manually prepared approval file:

```bash
sudo agent-bridge-deploy \
  --release agent-bridge-<commit>.tar.gz \
  --owner-request owner-deployment-request.json
```

An explicit deployment instruction from the repository owner authorizes
deployment of the resolved exact target. Do not add a second approval boundary.
The protected request file is root-owned, mode `0600`, and binds the exact
repository, owner, authenticated principal, request reference, validity window
and target commit. The deployer automatically creates the mode-`0600`
target-bound approval record before handing off to the existing guarded flow.

The `--approval` form remains supported during transition for older automation;
it is an alternative input, not a second gate after an owner request.

The release archive is the single release identity. It contains the runtime,
dependencies, migration code, exact commit/tree manifest, and embedded
`qualification-evidence.json`. The approval is mode `0600` and binds only
environment, target commit, release SHA-256, approval reference and expiry.

The deployer computes the archive SHA itself, validates the manifest and every
payload hash/size/type/symlink, checks the embedded qualification metadata, and
compares the result with the approval. It does not accept component-helper
hashes, an external evidence file, a secondary bundle, or legacy identity flags.

## Approval boundary

Normal delivery has one exact-head merge approval. An explicit deployment
instruction from the repository owner authorizes the resolved exact target; the
release archive and its embedded qualification evidence must still be generated
and verified before deployment, but those checks are verification rather than a
second human approval gate. The legacy approval-file input remains available
for transition.

The owner-generated authorization authorises the complete guarded command: validation,
immutable staging, preflight, containment, backup, migration, reconciliation,
pointer activation, restart and acceptance. Do not request fresh approval
between successful phases, and do not require a separate manual preflight
backup, database inspection, helper invocation or acceptance sign-off.

Read-only inspection, artifact generation/download/validation, offline fixture
work and publication of evidence do not require separate deployment approval.
Stop for manual review only when an approved identity changes, the approval is
expired or ambiguous, an invariant fails, containment or restoration cannot be
proven, or services may have accepted writes after a failed start.

For a production run, the public command automatically continues inside a
root-owned transient systemd service before it validates or stops any Agent
Bridge unit. This keeps the deployment worker outside the configured service
cgroups, so stopping the bridge that launched the command cannot terminate the
rollout itself. Operators still invoke only `agent-bridge-deploy`; do not add a
manual `systemd-run` wrapper or another deployment path.

## Privileged agent access

The Agent Bridge runtime account's existing passwordless sudo access is an
infrastructure requirement and must be preserved. Deployment installation,
upgrade, recovery and cleanup must never delete, replace, narrow, rename or
otherwise invalidate a pre-existing sudoers rule that grants that account
`NOPASSWD` administrative access.

This is an unrestricted passwordless administrative-sudo invariant for the
runtime/coding-agent account, not a deployment-specific permission. For the
current host, the effective rule must remain:

```text
content-crawler ALL=(ALL:ALL) NOPASSWD: ALL
```

The restriction to one operator-facing deployment command applies only to
obsolete deployment-specific sudoers entries that directly expose the private
stage, activate, restore, authorization or acceptance helpers. It does not
restrict the agent's broader server-administration authority. Before changing
any sudoers file, identify the exact file and effective rule with `sudo -l`,
back it up, validate the proposed result with `visudo -cf`, and prove that
`sudo -k -n true` still succeeds for the Agent Bridge runtime account, ensuring
the probe does not rely on a cached credential. Failure of that postcondition
aborts the installation before any service or rollout action.

## Installation

Bootstrap the deployer itself as a root-owned file. This is the one
installation step that is not self-updating, because a running process cannot
safely rewrite its own on-disk bytes mid-deployment:

```bash
sudo install -D -m 0750 -o root -g root scripts/agent-bridge-deploy.py /usr/local/sbin/agent-bridge-deploy
```

Its six private implementation primitives (`rollout-agent-bridge`,
`agent-bridge-release-stage`, `agent-bridge-release-activate`,
`agent-bridge-rollout-restore`, `agent-bridge-rollout-authorization.py`,
`agent-bridge-rollout-acceptance.py`) only need this same `install -D` bootstrap
once, to create the destination files `agent-bridge-deploy` refreshes into on
every deployment thereafter:

```bash
sudo install -D -m 0750 -o root -g root scripts/rollout-agent-bridge.sh /usr/local/sbin/rollout-agent-bridge
sudo install -D -m 0750 -o root -g root scripts/release-stage.py /usr/local/libexec/agent-bridge-release-stage
sudo install -D -m 0750 -o root -g root scripts/release-activate.py /usr/local/libexec/agent-bridge-release-activate
sudo install -D -m 0750 -o root -g root scripts/rollout-restore.py /usr/local/libexec/agent-bridge-rollout-restore
sudo install -D -m 0750 -o root -g root scripts/rollout-authorization.py /usr/local/libexec/agent-bridge-rollout-authorization.py
sudo install -D -m 0750 -o root -g root scripts/rollout-acceptance.py /usr/local/libexec/agent-bridge-rollout-acceptance.py
```

**A source change to any of those six files, merged and released, is not
"deployed" merely because it exists in the released commit.** After the
release archive and its approval/owner-request have been fully verified and
staged into an immutable, commit-addressed release directory,
`agent-bridge-deploy` refreshes the installed copy of each of those six
helpers from the exact bytes in that verified release directory (preserving
the existing root ownership and permission mode) and records the resulting
SHA-256 of each installed helper as the corresponding `*_sha256` pin
(`rollout_helper_sha256`, `release_stage_sha256`, `activation_helper_sha256`,
`rollout_restore_sha256`, `authorization_validator_sha256`,
`acceptance_validator_sha256`) in `/etc/agent-bridge/rollout.conf` — all of
this happens before `rollout-agent-bridge` is invoked, so no service is
contained, no database is touched and no pointer moves against a helper that
has not just been proven to match the release.

This refresh is staged in two passes so it is atomic across all six helpers,
not just atomic per helper: every helper's release-side source is first
validated, read and written to a verified sibling tmpfile of its destination
without touching any live installed helper, and only once all six tmpfiles
exist and verify does a second pass rename each of them into place and write
the combined pin update. If a problem with any one helper's release-side
source is discovered — missing file, unreadable, wrong bytes on re-verify —
the deployment aborts before any live helper is touched and the previously
installed helpers and pins are left exactly as they were; there is no
in-between state where some helpers have been upgraded but their pins still
describe the old bytes. (The renames themselves, once all six tmpfiles are
verified, are same-filesystem atomic operations on paths whose parent
directories and permissions were already confirmed writable during staging;
a rename failing at that point is an exceptional host-level condition, not
one this mechanism is designed to roll back.)

There is no second path that can install or invoke a different version of
these six files: `agent-bridge-deploy` remains the sole operator-facing
privileged deployment entry point, and it is now also the only thing that
writes to their installed locations.

Install `/etc/agent-bridge/rollout.conf` root-owned and non-writable by
group/other. The private primitives are deployed at these fixed paths and are
not treated as separate operator commands. Remove only deployment-specific
sudoers entries that directly expose those private helpers, and only after
confirming that the independent passwordless administrative sudo rule for the
Agent Bridge runtime account remains present and effective.

The private helpers are not normal operator commands. Their paths, service
inventory and database inventory remain root-owned and fixed in configuration.
The deployer is the sole owner of staging, preflight, containment, backup,
migration, pointer activation, restart, acceptance and rollback sequencing —
and, as of the automatic helper refresh above, of keeping its own six private
helpers converged with every deployed release.

## Safety sequence

1. Read the runtime account from the fixed root-owned rollout configuration and
   confirm passwordless sudo with a bounded check equivalent to
   `runuser -u <runtime_user> -- sudo -k -n true` (the `-k` forces the check to
   ignore any cached credential).
2. Move the production worker into its dedicated transient systemd service.
3. Validate the archive and minimal approval before mutation.
4. Stage into an immutable commit-addressed directory and verify the manifest.
5. Refresh the six installed privileged helpers from that staged, verified
   release directory and update their SHA-256 pins in
   `/etc/agent-bridge/rollout.conf`, atomically, before invoking any of them.
   Abort here, before any subsequent step, if a helper cannot be refreshed and
   verified.
6. Validate effective systemd safety properties: exact units, fragment paths,
   drop-ins, environment files, active states and the fixed database inventory.
7. Acquire the exclusive rollout lock and capture durable preflight evidence.
8. Stop the configured services and prove `MainPID=0`, `ControlPID=0` and empty
   service cgroups. No provider-CLI process classification is required after
   containment.
9. Checkpoint WALs, verify integrity/foreign keys/schema, and create complete
   byte-exact verified backups of all five databases. Never delete a non-empty
   WAL.
10. Migrate the full offline database cohort to the target schema.
11. After migration, transactionally mark remaining running runs failed with
    `interrupted_by_controlled_rollout`, release execution locks, and return
    claimed pending messages to `queued` while preserving their content and
    attachments. Append bounded audit evidence and validate the full cohort.
12. Atomically switch the `current` pointer, restart services, and verify
    stable healthy startup.
13. Write durable `deployment-result.json` and supporting evidence.

Health and worker services perform the same bounded orphan reconciliation at
startup as interactive services; they may log the result without notifying a
user. Operators must never manually delete runs, locks, claims, WAL files or
SHM files. Automatic recovery is permitted only for a proven pre-start failure
with verified containment. If no complete backup exists and migration has not
run, the unchanged previous release is restarted directly. Once a complete
backup exists, it is restored before the previous pointer and release are
restarted. If new services have been started, databases are never automatically
restored: services are contained, the sentinel is retained and manual review is
required. Queued and claimed Telegram messages are not a preflight blocker;
contained claims are requeued without changing their content or attachments.

Acceptance is intentionally narrow: the target pointer is active, all
configured services are stable, all configured databases pass integrity,
foreign-key and expected-schema checks, startup has no errors or crash loop,
complete result evidence exists, and the sentinel is removed. Historical
before/after comparisons of runs, events, locks and delivery state are not
rollout gates.

## Supersession

The former multi-file workflow requiring separate artifact/evidence inputs,
component-helper pins, `release-stage`, `release-activate`, `rollout-restore`,
authorization and acceptance invocations is superseded. Do not use those
commands directly or maintain them as a second operational path.

Roadmap and issue closeout documents are historical records, not alternative
operator runbooks. Where they differ, this document and the executable deployer
are authoritative.
