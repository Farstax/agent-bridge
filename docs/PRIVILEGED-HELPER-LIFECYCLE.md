# Privileged helper lifecycle

`agent-bridge-deploy` has two bootstrap trust anchors and five release-converged helpers.

## Bootstrap trust anchors

These files are installed explicitly by an operator and are **not** self-updated during the deployment they validate:

- `/usr/local/sbin/agent-bridge-deploy` from `scripts/agent-bridge-deploy.py`
- `/usr/local/libexec/agent-bridge-release-stage` from `scripts/release-stage.py`

This boundary is deliberate. The installed `release-stage` helper validates and stages the archive before any code from that archive is trusted. Therefore a release cannot safely replace the validator that is being used to establish trust in that same release.

A source change to either bootstrap trust anchor requires an explicit bootstrap installation of that file before relying on the new behavior. Do not describe a changed `release-stage.py` as deployed merely because the file exists in a newly published release.

## Release-converged helpers

After the bootstrap `release-stage` helper has validated the archive and staged it into an immutable commit-addressed release directory, `agent-bridge-deploy` converges these five installed helpers to the exact staged release bytes:

- `/usr/local/sbin/rollout-agent-bridge`
- `/usr/local/libexec/agent-bridge-release-activate`
- `/usr/local/libexec/agent-bridge-rollout-restore`
- `/usr/local/libexec/agent-bridge-rollout-authorization.py`
- `/usr/local/libexec/agent-bridge-rollout-acceptance.py`

Their corresponding `rollout.conf` SHA-256 pins are updated in the same rollback transaction.

## Deployment serialization

The detached `agent-bridge-deploy` worker acquires the fixed root-owned `/run/lock/agent-bridge-deploy.lock` before validating or staging a mutating deployment. It holds that lock through helper convergence and until `rollout-agent-bridge` returns.

This is a separate lock from the rollout helper's own lock. The deployer must not acquire the rollout helper lock itself because the child rollout process acquires that lock and would deadlock against its parent.

Only one mutating deployment can therefore own the installed helper cohort and `rollout.conf` at a time. A second deployment may be started, but it cannot validate against, replace, or execute a helper cohort until the first deployment has finished its guarded rollout and released the deployer lock.

Read-only `--validate-only` operations do not acquire the deployer lock because they cannot change the staged release, helper cohort, config, databases, services, or current pointer.

## Transaction boundary

Before the first live helper path changes, the serialized deployer stages:

1. all five replacement helper files;
2. a byte-exact rollback snapshot of all five currently installed helpers;
3. a byte-exact rollback snapshot of `/etc/agent-bridge/rollout.conf`; and
4. the complete new `rollout.conf` content with all five replacement hashes.

Only after all of that succeeds does publication begin.

If any helper publication, post-publication hash check, or config-pin publication fails, the deployer restores all five old helpers and the old config from the staged rollback snapshots and verifies the restored hashes before returning the error. `rollout-agent-bridge` is never invoked after a failed refresh transaction.

This gives each serialized deployment only two valid observable states at the rollout boundary:

- the complete previous helper cohort with the previous config; or
- the complete new helper cohort with matching new pins.

A host failure that also prevents rollback itself is reported as a compound refresh-and-rollback failure and must be treated as a manual recovery condition.

## Operational consequence

For ordinary releases, no manual helper refresh is required: the five release-converged helpers update automatically before rollout begins.

For a release that changes `agent-bridge-deploy.py` or `release-stage.py`, bootstrap the changed trust-anchor file explicitly first, then run the normal guarded deployment. The remaining five helpers still converge automatically from the verified release.
