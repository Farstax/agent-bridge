# Capability Registry Architecture

## Status

Canonical architecture documentation for the intended minimal registry.

The active implementation scope is defined by `docs/roadmap/epic-11-runtime-hardening.md`.

## Purpose

The Capability Registry describes what Agent Bridge can do, how a capability is scoped, and how readiness can be diagnosed.

It is a small runtime registry, not a plugin marketplace.

## Why It Exists

Without a registry, new functionality tends to become ad hoc conditionals and provider-specific branches. A registry gives conversational and event Run paths a shared way to ask:

- Is this capability known?
- Is it available here?
- Is it surface-scoped or shared?
- What risk level does it carry?
- What backend should be tried first?
- How should readiness be diagnosed?

## Minimal Capability Shape

A capability should expose metadata similar to:

```text
id
kind
scope
risk_level
requires_auth
requires_user_login_state
diagnostic_status
install_hint
preferred_backends
fallback_backends
policy_required
```

## Scopes

### `companion`

Usable by the Companion Runtime only.

Examples:

- general research surfaces
- summarisation helpers
- document transformation helpers

Examples:

- Git writes
- GitHub issue/PR writes
- CI checks
- test runner execution

### `shared`

Usable by both products through policy.

Examples:

- provider availability
- filesystem read where allowed
- terminal diagnostics where allowed
- notifications

## Risk Levels

The registry should distinguish low-risk metadata/read capabilities from higher-risk execution or write capabilities.

Initial categories may be simple:

- `read`
- `write`
- `execute`
- `destructive`

Repository instructions, Skills, provider policy, and human approvals govern dangerous actions.

## Diagnostics

A capability may report readiness through doctor checks:

- available
- missing
- misconfigured
- unavailable by policy
- unknown

Diagnostics should be actionable and safe to run.

## Non-Goals

The minimal registry does not implement:

- browser automation
- third-party plugin loading
- marketplace distribution
- remote capability execution
- credential/cookie storage
- automatic installation of arbitrary tools

Those topics remain research-only unless promoted into a future roadmap.
