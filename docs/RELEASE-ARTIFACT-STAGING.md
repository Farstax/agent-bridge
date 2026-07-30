# Release staging (private implementation)

This document is retained only as an implementation note for
`agent-bridge-deploy`. Operators must use the single command documented in
[`GUARDED-ROLLOUT.md`](GUARDED-ROLLOUT.md); do not invoke the staging helper
directly. The deployer supplies the archive digest internally, stages it into
the immutable commit-addressed release root, validates the manifest, and then
continues through containment and rollout.

Health database relocation is also private rollout machinery. With a
`legacy_database` entry, the guarded helper accepts the legacy path only when
the configured runtime target is absent, then performs the commit-bound
relocation after containment, WAL drain and cohort backup. Operators must not
copy, delete, or repair the database manually.
