# Shared Runtime Architecture

## Status

Canonical architecture documentation.

## Purpose

The Shared Runtime provides common services consumed by conversational and unattended Run paths.

It prevents duplication while keeping product-specific domain models separate.

## Responsibilities

Shared Runtime may provide:

- provider / CLI selection
- CLI process invocation seams
- session persistence boundaries
- SQLite persistence helpers
- event and audit records
- memory access seams
- notifications
- metrics and health checks
- authentication and authorization seams
- secrets access seams
- capability registry
- diagnostics

## Dependency Direction

```text
Companion and event Run paths ── Shared Runtime
```

Shared Runtime must not depend on surface-specific runtime internals.

Product-specific concepts must remain outside Shared Runtime unless they are represented as neutral interfaces or metadata.

## Boundary Rules

Shared Runtime may know about:

- providers
- capabilities
- sessions
- notifications
- diagnostics
- generic policy metadata

Shared Runtime must not own:

- Telegram-specific conversational command behavior
- Discord-specific conversational command behavior
- Worker work item lifecycles. These are legacy database data only.
- TDD phases
- GitHub PR state machines
- merge approval state machines

## Epic 11 Scope

Epic 11 should introduce only small shared seams:

- minimal capability registry
- shared provider/fallback abstractions
- doctor diagnostic plumbing
- tests for scope and fallback behavior

It should not perform a broad directory move or service rename.

## Memory and Handoff Seams

Recorded for issue #69 without changing the boundary rules above.

Shared Runtime may provide neutral services for:

- loading conversation turns and compact summaries;
- chunking and reducing un-compacted conversation turns;
- validating/storing persistent memory candidates;
- building provider-agnostic handoff context;
- tracking one-time handoff state.

The Companion Runtime and event Run paths decide when those services are invoked and which compact profile to use.

Shared Runtime must not own surface-specific chat behavior or engineering workflow lifecycles. Provider agents and Skills own that work.

The canonical memory and handoff architecture is `docs/architecture/memory-and-handoff.md`.
