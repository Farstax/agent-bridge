# Platform Boundary Architecture

## Status

Canonical architecture documentation.

## Purpose

This document defines the boundary between Agent Bridge OSS and the hosted Agent Bridge Platform.

## OSS Responsibilities

Agent Bridge OSS owns autonomous execution.

It contains:

- Companion Runtime
- Shared Runtime
- local runtime state
- provider/CLI execution
- ordinary Runs and event receipts
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

A platform-managed workspace may enable the conversational, Discord, health, and event Run services required by its deployment.

The Platform should treat these as runtime modules/capabilities of an OSS deployment, not as separate execution engines owned by the control plane.

## Boundary Rule

The Platform may start, stop, configure, update, and monitor Agent Bridge deployments.

The Platform should not own autonomous prompt execution, planning, TDD implementation, PR lifecycle, or merge decision logic. Provider agents and repository Skills own engineering workflow.

## Licensing Boundary

Agent Bridge material in the public `agent-bridge` repository is licensed under Apache-2.0 except where bundled third-party material states another licence.

That repository licence does not apply to `agent-bridge-platform`, the Farstax hosted control plane, managed hosting or provisioning services, commercial operations, branding, or other proprietary Platform assets. Platform code and services remain separately licensed even when they provision or operate an Apache-2.0 Agent Bridge deployment.

## Security and Policy

Secrets, tokens, and runtime credentials should be scoped to the deployment that needs them.

The Platform may help provision or distribute configuration, but runtime-specific authority should remain explicit and auditable.

## Recommended Configuration for Platform-Managed Workspaces

Set `BRIDGE_PRESEED_COMPACT_MODE=auto` and `BRIDGE_PRESEED_COMPACT_CHARS=30000`.

Provider adapters inject context into fresh native sessions, then rely on provider-native continuity. Pre-seed compaction keeps a large fresh seed bounded. See `docs/architecture/memory-and-handoff.md` and `docs/architecture/companion-runtime.md` for the full mechanism.
