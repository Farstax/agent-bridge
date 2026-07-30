# Guarded production deployment

The only operator-facing deployment path is the root-owned `agent-bridge-deploy`
deployer. The old stage/activate/restore/authorization/acceptance commands are
private implementation details and are not an alternative runbook.

## Two inputs

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

## Approval boundary

Normal delivery has one exact-head merge approval and, only when production
deployment is requested, one exact-release deployment approval. The release
archive and its embedded qualification evidence must be generated and verified
before deployment, but those checks are verification rather than separate human
approval gates.

One deployment approval authorises the complete guarded command: validation,
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
Bridge unit. This keeps the deployment worker outside the seven service
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
not treated as separate operator commands. Remove only deployment-specific
sudoers entries that directly expose those private helpers, and only after
confirming that the independent passwordless administrative sudo rule for the
Agent Bridge runtime account remains present and effective.

The private helpers are not normal operator commands. Their paths, service
inventory and database inventory remain root-owned and fixed in configuration.
The deployer is the sole owner of staging, preflight, containment, backup,
migration, pointer activation, restart, acceptance and rollback sequencing.

## Safety sequence

1. Read the runtime account from the fixed root-owned rollout configuration and
   confirm passwordless sudo with a bounded check equivalent to
   `runuser -u <runtime_user> -- sudo -k -n true` (the `-k` forces the check to
   ignore any cached credential).
2. Move the production worker into its dedicated transient systemd service.
3. Validate the archive and minimal approval before mutation.
4. Stage into an immutable commit-addressed directory and verify the manifest.
5. Validate effective systemd safety properties: exact units, fragment paths,
   drop-ins, environment files, active states and the fixed database inventory.
6. Acquire the exclusive rollout lock and capture durable preflight evidence.
7. Stop all seven services and prove `MainPID=0`, `ControlPID=0` and empty
   service cgroups. No provider-CLI process classification is required after
   containment.
8. Checkpoint WALs, verify integrity/foreign keys/schema, and create complete
   byte-exact verified backups of all five databases. Never delete a non-empty
   WAL.
9. Migrate the full offline database cohort to the target schema.
10. After migration, transactionally mark remaining running runs failed with
    `interrupted_by_controlled_rollout`, release execution locks, and return
    claimed pending messages to `queued` while preserving their content and
    attachments. Append bounded audit evidence and validate the full cohort.
11. Atomically switch the `current` pointer, restart services, and verify
    stable healthy startup.
12. Write durable `deployment-result.json` and supporting evidence.

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

Acceptance is intentionally narrow: the target pointer is active, all seven
services are stable, all five databases pass integrity, foreign-key and
expected-schema checks, startup has no errors or crash loop, complete result
evidence exists, and the sentinel is removed. Historical before/after
comparisons of runs, events, locks and delivery state are not rollout gates.

## Supersession

The former multi-file workflow requiring separate artifact/evidence inputs,
component-helper pins, `release-stage`, `release-activate`, `rollout-restore`,
authorization and acceptance invocations is superseded. Do not use those
commands directly or maintain them as a second operational path.

Roadmap and issue closeout documents are historical records, not alternative
operator runbooks. Where they differ, this document and the executable deployer
are authoritative.
