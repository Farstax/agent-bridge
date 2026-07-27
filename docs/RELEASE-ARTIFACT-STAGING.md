# Release artifact staging

This is the first server-side slice of Issue #183. It verifies and stages one
CI-produced release artifact into a commit-addressed immutable directory. It
does not stop services, access databases, change queues or workspaces, switch
the active release pointer, or deploy production.

## Installation

Install the helper outside the Git checkout as a root-owned executable:

```bash
sudo install -D -o root -g root -m 0750 \
  scripts/release-stage.py /usr/local/libexec/agent-bridge-release-stage
sudo install -d -o root -g root -m 0750 /opt/agent-bridge/releases
```

The production helper is root-only. It accepts an explicit exception only in
the fixture tests.

## Invocation

After downloading the artifact and verifying its external checksum:

```bash
sudo -n /usr/local/libexec/agent-bridge-release-stage \
  --archive /var/lib/agent-bridge/artifacts/agent-bridge-<commit>.tar.gz \
  --release-root /opt/agent-bridge/releases \
  --expected-commit <full-40-character-commit-sha> \
  --archive-sha256 <verified-archive-sha256>
```

The helper validates that:

- the archive is a regular non-symlink file;
- the archive SHA-256 matches the explicitly supplied expected digest before extraction;
- the embedded manifest is schema 1 and matches the expected commit;
- every listed file has the expected hash and size;
- package-lock identity is bound by the manifest;
- archive paths and symlink targets remain inside the release directory;
- an existing release is already valid and immutable before it is reused.

The CI-produced artifact includes both the compiled `dist/` output and the
source entrypoints plus guarded migration scripts required by the current
systemd and rollout contracts. This keeps service startup and offline
migration on the same release identity until a separately reviewed compiled
migration entrypoint replaces those TypeScript paths.

The publication directory is created under the configured release root and is
renamed into its final `<commit>` path only after validation and permission
hardening. A failed or interrupted staging operation leaves no accepted
release at that commit path. Staging also writes an immutable,
commit-addressed `.staging-provenance.json` record beside the release. The
guarded rollout helper verifies that record against the approved artifact
digest before creating its interruption sentinel.

Pointer activation is now covered by `docs/RELEASE-POINTER-ACTIVATION.md`, but
this staging helper still does not invoke it. Service restart, database
migration, rollback, and release retention remain governed by the existing
guarded rollout contract until their later Issue #183 phases land.
