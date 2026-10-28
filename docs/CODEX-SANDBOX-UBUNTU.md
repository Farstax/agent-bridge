# Codex sandbox on Ubuntu

Agent Bridge keeps Codex sandboxing enabled. It does not change AppArmor's
`kernel.apparmor_restrict_unprivileged_userns` setting or approve an unsandboxed
retry.

## Confirm the executable and policy first

Codex uses the first `bwrap` executable on `PATH`. Check this as the Agent
Bridge runtime user, with the same environment as the Codex ACP process:

```bash
command -v bwrap
printf '%s\n' "$PATH"
sysctl kernel.apparmor_restrict_unprivileged_userns
sudo aa-status
```

If `command -v` returns `/usr/bin/bwrap`, Codex uses Ubuntu's system
`bubblewrap`. If it returns another path, do not add a profile for that path as
a workaround. Confirm why the process environment differs and correct the
intended `PATH` owner. Codex's bundled helper is a fallback when no `bwrap` is
available on `PATH`.

Before changing policy, inspect both the loaded profile list and files that
attach to `/usr/bin/bwrap`:

```bash
sudo aa-status | grep -i bwrap || true
sudo grep -R -nE 'profile .*(/usr/bin/bwrap|bwrap)|/usr/bin/bwrap' /etc/apparmor.d
```

If a bwrap profile is already loaded or an existing policy file attaches to
`/usr/bin/bwrap`, stop and inspect that policy. Do not install a second profile
with the same attachment or profile name. A collision can stop either profile
from attaching.

## Ubuntu 24.04 LTS

Ubuntu's distribution-maintained profile is in the `apparmor-profiles`
package at `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict`. The
extra profile is not active by default. Capture the loaded profile list before
changing policy. Extract only this file from the Ubuntu package so the other
experimental profiles in that package do not change the host:

```bash
profile_tmp="$(mktemp -d)"
(cd "$profile_tmp" && apt-get download apparmor-profiles && dpkg-deb -x ./*.deb extracted)
sudo test ! -e /etc/apparmor.d/bwrap-userns-restrict
sudo install -m 0644 \
  "$profile_tmp/extracted/usr/share/apparmor/extra-profiles/bwrap-userns-restrict" \
  /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
rm -rf "$profile_tmp"
sudo cat /sys/kernel/security/apparmor/profiles | grep -E '^(bwrap|unpriv_bwrap) '
```

Only continue when the loaded `bwrap` profile is the Ubuntu profile and no
other profile changed. Remove the temporary download if a command fails.

The profile lets the system `bwrap` prepare namespaces. Its child profile
removes capabilities. Codex still uses bubblewrap filesystem and network
namespaces for each command.

Rollback this change by unloading and removing only the file created above:

```bash
sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict
sudo rm /etc/apparmor.d/bwrap-userns-restrict
sudo cat /sys/kernel/security/apparmor/profiles | grep -E '^(bwrap|unpriv_bwrap) ' || true
```

## Ubuntu 26.04 LTS

The Ubuntu `apparmor` package includes
`/etc/apparmor.d/bwrap-userns-restrict`. Check that this file exists and that
`aa-status` lists the `bwrap` and `unpriv_bwrap` profiles. When they are already
loaded, leave them as shipped. Do not copy the 24.04 extra profile or create a
second attachment. If the packaged profile is missing or not loaded, inspect
the package and AppArmor service state, then repair the Ubuntu package using
the host's normal package-management procedure.

This guidance changes no Ubuntu 26.04 workspace automatically. Validate the
specific host before any local repair.

## Verify the effective sandbox

Run as the non-root Agent Bridge runtime user. Keep the global restriction at
`1`:

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns
command -v bwrap
bwrap --unshare-user --unshare-net --ro-bind / / -- /bin/sh -c \
  'touch /tmp/agent-bridge-sandbox-probe-$$'
```

The bwrap command must start. Its output must say `Read-only file system`, and
the probe file must not exist. Test network separation by opening a temporary
listener on host loopback, then confirming a command inside `bwrap
--unshare-net` cannot connect to that listener. Finally, run a sandboxed Codex
ACP task and confirm it completes without a permission request for its first
repository read.

If bwrap still reports `loopback: Failed RTM_NEWADDR: Operation not permitted`,
stop. Recheck the executable path, profile attachment, loaded policy and kernel
audit denial. Do not disable the AppArmor sysctl, grant global capabilities,
weaken nspawn isolation, or use an unsandboxed retry.
