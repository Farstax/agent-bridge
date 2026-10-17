# ADR-004 — License Agent Bridge under Apache-2.0

## Status

Accepted — 2026-08-22.

## Context

Agent Bridge is intended to remain a freely usable and forkable open-source runtime, independent of any particular hosting or commercial deployment model.

The repository previously had no root licence, so public visibility did not give users an explicit right to use, modify, or redistribute the code.

## Decision

License Agent Bridge material in this repository under the Apache License, Version 2.0 (`Apache-2.0`), except where a file or bundled third-party component states a different licence.

Apache-2.0 is selected because it is a standard permissive open-source licence, allows commercial use and forks, and includes an explicit patent licence and patent-termination provision. MIT was also suitable for the permissive product model, but it does not contain the same explicit patent grant. A bespoke source-available licence is not justified by the current product model.

Third-party material keeps its original licence and attribution. See `THIRD_PARTY_NOTICES.md` and any licence files stored with that material.

## Licence boundary

This decision applies only to material in the public `agent-bridge` repository. Independently licensed software or services outside the repository are not covered. Deployment responsibilities remain described by `docs/architecture/platform-boundary.md`.

## Consequences

- Agent Bridge can be used, modified, redistributed, and forked under Apache-2.0.
- Commercial use of the OSS runtime is permitted by the licence.
- Contributors and redistributors must comply with Apache-2.0 terms and preserve applicable third-party notices.
- Licensing for software or services outside this repository is a separate decision.
- No CLA or custom licensing framework is introduced by this decision.
