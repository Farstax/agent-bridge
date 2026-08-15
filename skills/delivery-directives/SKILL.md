---
name: delivery-directives
description: Use when the user says "ship it", "release it", or "hotfix" to execute the repository's existing delivery, release, or emergency-restoration workflow without inventing parallel orchestration.
---

# Delivery Directives

Use these directives as authorization shorthands only after the relevant scope or emergency failure is understood. Repository-local instructions and required safety/quality gates remain authoritative.

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

## `hotfix`

Treat `hotfix` as authorization to restore production or a release-blocking qualification as an emergency. It changes priority, not the required quality or safety gates.

- Confirm the actual failure and impact, and preserve enough concrete evidence to verify restoration and support the later RCA. Evidence capture must not delay restoration.
- Use the existing `systematic-debugging`, `red-green-refactor-tdd`, `risk-based-test-strategy`, `release-readiness-review`, and repository-local delivery mechanisms as applicable instead of reproducing their procedures here.
- Make the smallest safe change that resolves the confirmed failure. While unstable, defer unrelated cleanup, refactors, architecture changes, speculative improvements, and broader hardening.
- Preserve mandatory regression tests, required CI and release gates, exact-head review, rollback safety, and the repository's supported deployment or release path. Emergency status is not permission to bypass them.
- Verify the original failure is resolved in the real affected environment and prove production or qualification is stable before moving to post-incident work.
- Do not create the RCA issue until stability is proven. Once stable, create an RCA issue covering the incident or failure summary, impact and timeline, triggering condition, root cause, why existing tests/detection/controls did not prevent it, the hotfix and deployment/verification evidence, residual risk, and any temporary compromises.
- Recommend a separate long-term fix only when the evidence shows one is warranted. Any long-term implementation returns to the normal issue and `ship it` path.
- Exit hotfix mode once stability is established and the RCA handoff is complete. Do not keep unrelated follow-up work inside the emergency scope.
