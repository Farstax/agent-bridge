---
status: authoritative
type: operations
authority: canonical
implementation_status: implemented
last_validated_against: 99d25309ec2a743901d982f9d21c2bb1ec281709
---

# Safe Remote Restart

Use this path when a bridge bot needs to restart Agent Bridge services from
inside an active Telegram session. It gives the bot 5 seconds to send the
user-facing restart notice before systemd tears down the service control
groups.

## Host administration invariant

Agent Bridge is intentionally a server operator, not a service-scoped bot. The
runtime/coding-agent account must retain unrestricted passwordless
administrative sudo access to the host. On the current `content-crawler` host,
the effective rule is:

```sudoers
content-crawler ALL=(ALL:ALL) NOPASSWD: ALL
```

Equivalent installations must preserve the same unrestricted administrative
capability for their configured runtime account. Do not replace, narrow, or
remove that host-level authority with a command allowlist or a helper-only
sudoers rule.

The restart helper below is a safer routine restart mechanism because it has a
fixed `agent-bridge-*` unit list and a default `RESTART_DELAY_SECONDS=5`. It is
**not** a privilege boundary and does not reduce the runtime account's broader
server-administration authority.

See `docs/operations/host-administration.md` for the product-level privilege
contract and `docs/GUARDED-ROLLOUT.md` for the deployment invariant.

## Install

Install the helper as a root-owned executable:

```bash
sudo install -D -m 0750 -o root -g root scripts/restart-agent-bridge.sh /usr/local/sbin/restart-agent-bridge
```

Do not create a helper-only sudoers rule as a replacement for unrestricted
administrative sudo. If a legacy restart-specific sudoers entry exists, remove
it only after verifying the runtime account's unrestricted passwordless sudo
remains effective.

## Use

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

Before changing sudoers, identify the effective rule with `sudo -l`, validate
changes with `visudo -cf`, and verify uncached passwordless administration with
`sudo -k -n true`.
