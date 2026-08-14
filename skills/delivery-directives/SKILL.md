---
name: delivery-directives
description: Use when the user says "ship it" or "release it" after scope is agreed, to execute the repository's existing delivery or release workflow without inventing parallel orchestration.
---

# Delivery Directives

Use these directives as authorization shorthands only after the relevant scope is already agreed. Repository-local instructions and required safety/quality gates remain authoritative.

## `ship it`

Treat `ship it` as authorization to execute the already-agreed scope end to end.

- Follow the repository's `AGENTS.md` and existing engineering skills and processes.
- Implement only the agreed scope; update documentation made inaccurate or incomplete by the change.
- Use existing validation, review, CI, merge, and cleanup machinery rather than reproducing it.
- Do not ask for routine procedural confirmations already covered by the directive.
- Do not expand scope, bypass required gates, weaken invariants, or conceal blockers.

## `release it`

Treat `release it` as authorization to release the current qualified candidate through the repository's established release path.

- Identify and use the repository's existing release process and `release-readiness-review` skill.
- Review changes since the previous release only for concrete release blockers, integration problems, migrations, compatibility concerns, or operational changes. Do not reopen already-reviewed implementation work without a concrete reason.
- Produce meaningful user/operator release notes and correct required release-facing documentation.
- Reuse exact-candidate qualification evidence and existing publish, deploy, and verification automation; do not duplicate CI or rebuild a second artifact.
- If no concrete blocker remains, proceed without routine additional approval.
- Verify through existing deployment or acceptance checks; use the established failure or rollback process when checks fail.
- Never invent deployment machinery when none exists; report the exact missing capability as the blocker.
