---
status: authoritative
type: operations
authority: canonical
implementation_status: implemented
last_validated_against: 99d25309ec2a743901d982f9d21c2bb1ec281709
---

# Host Administration Authority

Agent Bridge is designed to operate a server through its coding agents. Full
host administration is therefore a product capability and an intentional trust
boundary, not an incidental permission used only by deployment scripts.

## Required authority

The configured non-root runtime/coding-agent account must have unrestricted
passwordless administrative sudo access to the host.

For the current `content-crawler` host, the effective rule is:

```sudoers
content-crawler ALL=(ALL:ALL) NOPASSWD: ALL
```

Other installations may use a different runtime account, but the capability is
the same: that account must be able to perform arbitrary administrative actions
without an interactive password prompt.

A valid installation or upgrade must preserve this authority. Installation,
deployment, recovery, cleanup, hardening, or helper installation must never
replace it with a command allowlist, narrow it to Agent Bridge services, or
remove it because a bounded helper exists.

## Why this is part of Agent Bridge

Agent Bridge is intended to let an authenticated owner use an agent as an
operator of the host, including work that crosses ordinary application
boundaries. Depending on the task, that can include:

- inspecting and managing systemd services;
- reading and repairing host configuration;
- managing packages, files, ownership, and permissions;
- diagnosing networking, storage, processes, and resource pressure;
- installing or upgrading runtime dependencies;
- performing controlled recovery and maintenance outside the Agent Bridge
  service directory.

Restricting the runtime account to a small sudo command set would materially
weaken that operating model and should not be presented as a security
improvement within the current product contract.

## Bounded helpers do not reduce authority

Agent Bridge can still provide narrow helpers for common high-risk or
self-disruptive operations. Those helpers improve sequencing, consistency, and
recovery; they are not the authorization boundary for the runtime account.

For example, `scripts/restart-agent-bridge.sh` is the preferred way to restart
Agent Bridge services from an active chat because it delays the restart long
enough to send the user-facing notice and targets the expected unit set. The
runtime account nevertheless retains unrestricted host administration before
and after that helper is installed.

Likewise, `agent-bridge-deploy` is the single operator-facing guarded deployment
command, but that deployment interface does not narrow the coding agent's
separate server-administration authority.

## Installation and verification invariant

Before treating a production host as ready, verify all of the following:

1. The runtime account exists and is non-root.
2. Uncached non-interactive sudo succeeds for that account, equivalent to:

   ```bash
   sudo -k -n true
   ```

3. The effective sudoers policy grants unrestricted administrative access.
4. Any sudoers mutation is validated with `visudo -cf` before activation.
5. Installers, deployers, recovery tools, and cleanup scripts preserve the
   pre-existing unrestricted rule.

A failure of the unrestricted passwordless-sudo postcondition is a host
configuration failure and must stop installation or deployment rather than
silently degrading the agent to partial host access.

## Security boundary

Unrestricted sudo makes control of the runtime/coding-agent account effectively
root-equivalent. That is intentional for this product model. Security controls
should therefore focus on protecting access to Agent Bridge and the runtime
account itself: authenticated/allowlisted chat users, credential handling,
provider authentication, host access, auditability, and guarded handling of
operations where interruption or rollback matters.

Do not compensate for weaknesses in those controls by silently reducing the
agent's host authority; doing so changes the product capability and must be an
explicit product decision.

## Documentation consistency rule

Documentation must distinguish between:

- **authority**: unrestricted passwordless administrative sudo for the runtime
  account; and
- **preferred operational paths**: bounded helpers or guarded workflows used to
  make particular operations safer and more deterministic.

Any guidance that says or implies the runtime account should be limited to a
helper-only sudoers rule, raw-command allowlist, or Agent-Bridge-only service
permissions conflicts with this invariant and should be corrected.

Related operational documentation:

- `docs/SAFE-RESTART.md`
- `docs/GUARDED-ROLLOUT.md`
