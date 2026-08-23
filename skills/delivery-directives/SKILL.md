---
name: delivery-directives
description: Use when the user says "ship it", "review it", "release it", "deploy it", or "hotfix" to authorize the repository's existing delivery workflow without duplicating its engineering mechanics.
---

# Delivery Directives

These commands are authorization shorthands. Repository instructions and the specialist skills own the engineering rules.

## `ship it`

Execute the already-agreed scope end to end without routine confirmation:

`issue/requirements -> draft PR -> implementation + focused validation -> review it -> in-scope repairs/re-review -> final candidate -> required exact-head checks -> merge -> cleanup -> compact report`

- Do not expand scope, bypass required checks, weaken invariants, or conceal blockers.
- Keep iterative work draft/local where practical so intermediate RED/GREEN and repair states do not trigger full qualification unnecessarily.
- `review it` is the authoritative independent adversarial review contract; do not maintain a second review checklist here.
- Once review passes, qualify the exact merge-candidate head. Any head change invalidates head-bound evidence that depends on it.
- Routine completion reports answer: what changed, whether it worked, and whether the user must do anything next. Include residual risk only when material.

## `review it`

Run the independent adversarial review defined by `release-readiness-review` against the current candidate. Prefer a fresh/context-isolated execution when available. Treat existing tests and implementation claims as evidence, not as the review conclusion.

## `release it`

Qualify and publish the current release candidate through the repository's established release path. Reuse exact-candidate evidence and existing publication automation; do not rebuild or rerun equivalent evidence without a concrete reason. It does not authorize production deployment.

## `deploy it`

Deploy the explicitly approved release identity through the repository's established guarded deployment path, including its preflight, post-deploy verification, and rollback behavior. It does not authorize creating a new release.

## `hotfix`

Restore a confirmed production or release-blocking failure with the smallest safe change. Preserve TDD, required qualification, review, rollback, and supported deployment paths. After stability is restored, the RCA must identify which prevention layer should reasonably have caught the defect and update the owning rule only when the lesson is reusable; do not add incident-specific ceremony by default.
