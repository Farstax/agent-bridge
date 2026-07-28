# Release staging (private implementation)

This document is retained only as an implementation note for
`agent-bridge-deploy`. Operators must use the single command documented in
[`GUARDED-ROLLOUT.md`](GUARDED-ROLLOUT.md); do not invoke the staging helper
directly. The deployer supplies the archive digest internally, stages it into
the immutable commit-addressed release root, validates the manifest, and then
continues through containment and rollout.
