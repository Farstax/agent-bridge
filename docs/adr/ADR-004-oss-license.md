# ADR-004 — License Agent Bridge under Apache-2.0

## Status

Accepted — 2026-08-22.

## Context

Agent Bridge is intended to remain a freely usable and forkable open-source runtime. Farstax's commercial model is managed hosting, provisioning, operations, and platform services rather than restricting use of the public runtime.

The repository previously had no root licence, so public visibility did not give users an explicit right to use, modify, or redistribute the code.

## Decision

License Agent Bridge material in this repository under the Apache License, Version 2.0 (`Apache-2.0`), except where a file or bundled third-party component states a different licence.

Apache-2.0 is selected because it is a standard permissive open-source licence, allows commercial use and forks, and includes an explicit patent licence and patent-termination provision. MIT was also suitable for the permissive product model, but it does not contain the same explicit patent grant. A bespoke source-available licence is not justified by the current product model.

Third-party material keeps its original licence and attribution. See `THIRD_PARTY_NOTICES.md` and any licence files stored with that material.

## Product boundary

This decision applies only to the public `agent-bridge` repository. It does not license `agent-bridge-platform`, the Farstax hosted control plane, managed hosting or provisioning services, commercial operations, or other proprietary Platform assets.

The runtime/platform responsibility boundary remains defined by `docs/architecture/platform-boundary.md`.

## Consequences

- Agent Bridge can be used, modified, redistributed, and forked under Apache-2.0.
- Commercial use of the OSS runtime is permitted by the licence.
- Contributors and redistributors must comply with Apache-2.0 terms and preserve applicable third-party notices.
- Farstax Platform licensing remains a separate decision outside this repository.
- No CLA or custom licensing framework is introduced by this decision.
