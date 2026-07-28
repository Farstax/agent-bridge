# Release pointer activation (private implementation)

Pointer publication is an internal phase owned by `agent-bridge-deploy`.
Operators must not invoke `release-activate.py` directly. The deployer invokes
the atomic pointer switch only after containment, WAL checkpointing, verified
backups, migration and validation have succeeded.
