---
name: delivery-directives
description: Use when the user says "ship it", "release it", "deploy it", or "hotfix" to execute the repository's existing delivery, release-publication, deployment, or emergency-restoration workflow without inventing parallel orchestration.
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

Treat `release it` as authorization to qualify and publish the current release candidate through the repository's established release-publication path. It does **not** authorize production deployment.

- Identify and use the repository's existing release process and `release-readiness-review` skill.
- Review changes since the previous release only for concrete release blockers, integration problems, migrations, compatibility concerns, or operational changes. Do not reopen already-reviewed implementation work without a concrete reason.
- Produce meaningful user/operator release notes and correct required release-facing documentation.
- Reuse exact-candidate qualification evidence and existing publication automation; do not duplicate CI or rebuild a second artifact.
- If no concrete blocker remains, publish the qualified candidate without routine additional approval.
- Verify the published release/tag/assets/provenance through the repository's existing release checks.
- Stop after publication and release verification. Do not deploy production unless the user separately says `deploy it` or otherwise explicitly authorizes deployment.
- Never invent release machinery when none exists; report the exact missing capability as the blocker.

## `deploy it`

Treat `deploy it` as authorization to deploy the already-published or otherwise explicitly approved release identity through the repository's established deployment path. It does **not** authorize publishing a new release.

- Resolve the exact release/tag/commit/artifact the user approved or, when the conversation has just produced one unambiguous release, use that release identity.
- Reuse existing deployment, rollback, migration, health, stability, smoke, and acceptance automation; do not duplicate rollout machinery.
- Perform the repository's required preflight and fail closed if the deployed target cannot be bound to the approved release identity.
- Proceed through the complete guarded deployment without asking for routine confirmations already covered by `deploy it`.
- Run the existing post-deploy verification and acceptance checks, including user-visible smoke checks when the release changes a public surface.
- If deployment or verification fails, use the established failure/rollback process and report the exact resulting state.
- Do not create or publish a new release as part of `deploy it`; if no deployable approved release exists, report that as the blocker.

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
