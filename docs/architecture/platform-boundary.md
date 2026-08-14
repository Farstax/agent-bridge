# Platform Boundary Architecture

## Status

Canonical architecture documentation.

## Purpose

This document defines the boundary between Agent Bridge OSS and the hosted Agent Bridge Platform.

## OSS Responsibilities

Agent Bridge OSS owns autonomous execution.

It contains:

- Companion Runtime
- Engineering Worker
- Shared Runtime
- local runtime state
- provider/CLI execution
- worker queue and merge gates
- capability registry and diagnostics

## Platform Responsibilities

The hosted Platform manages deployments and commercial operations.

It owns:

- user/workspace management
- provisioning
- deployment lifecycle
- upgrades
- billing
- authentication/control-plane access
- monitoring
- appliance lifecycle

## Workspace Composition

A platform-managed workspace may enable:

- Companion Runtime only
- Engineering Worker only
- both

The Platform should treat these as runtime modules/capabilities of an OSS deployment, not as separate execution engines owned by the control plane.

## Boundary Rule

The Platform may start, stop, configure, update, and monitor Agent Bridge deployments.

The Platform should not own autonomous prompt execution, worker planning, TDD implementation, PR lifecycle, or merge decision logic.

## Security and Policy

Secrets, tokens, and runtime credentials should be scoped to the deployment that needs them.

The Platform may help provision or distribute configuration, but runtime-specific authority should remain explicit and auditable.

## Recommended Configuration for Platform-Managed Workspaces

Set `BRIDGE_PRESEED_COMPACT_MODE=auto` and `BRIDGE_PRESEED_COMPACT_CHARS=30000`.

Provider adapters inject context into fresh native sessions, then rely on provider-native continuity. Pre-seed compaction keeps a large fresh seed bounded. See `docs/architecture/memory-and-handoff.md` and `docs/architecture/companion-runtime.md` for the full mechanism.
