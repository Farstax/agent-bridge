# Codex sandbox on Ubuntu 24.04

## Symptom

Codex cannot start a sandboxed command. A direct `codex exec` run prints

```
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

and, through Agent Bridge, a Codex ACP Run (for example a cross-provider review started with
`agent-bridge-review --provider codex`) sees its first read-only command stop at a permission
request. The review helper refuses every permission request in safe mode, so the Run ends as
`cancelled` and the helper reports `reviewer stopped without a completed turn (cancelled); refused
permission requests: execute "Read file"`.

## Cause

Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`. An unconfined program that creates
a user namespace is moved into the `unprivileged_userns` profile, which denies every capability. Codex's
sandbox starts commands through the `bwrap` it bundles under
`node_modules/@openai/codex-linux-x64/vendor/*/codex-resources/bwrap`, and bwrap needs a capability inside
its new namespace to configure the loopback device. The same command succeeds as root, which confirms
that the restriction is AppArmor policy, not a missing kernel feature and not container isolation.

`/usr/bin/bwrap` is affected in the same way because no AppArmor profile grants it `userns`.

## Fix

Grant `userns` to the bundled bwrap executable only, with
[`examples/apparmor/agent-bridge-codex-bwrap`](../examples/apparmor/agent-bridge-codex-bwrap). The profile
is `flags=(unconfined)`, so it confines nothing else, and the global sysctl stays at its default. Commands
that Codex runs are still isolated by bwrap.

Do not respond to the permission request by approving an unsandboxed retry, and do not set
`kernel.apparmor_restrict_unprivileged_userns=0`: either one removes the isolation for every program.

This is host configuration that the guarded rollout does not manage. Install and load the profile as
root, then start a fresh Codex Run.

## Verify

```bash
bwrap --ro-bind / / --unshare-net true            # expect: no output, exit 0 (this is the system bwrap and stays denied)
/opt/agent-bridge/releases/current/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap \
  --ro-bind / / --unshare-net true                # expect: exit 0 once the profile is loaded
```

Then run a cross-provider review and confirm the returned JSON has `result: "pass"` or `"findings"` with
`toolKinds` containing both `read` and `search`.
