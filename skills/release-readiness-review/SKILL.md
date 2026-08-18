---
name: release-readiness-review
description: Use before merging or releasing software changes to check scope, migrations, feature flags, rollback paths, documentation, monitoring, and operational readiness.
---

# Release Readiness Review

Use this skill for pre-merge, pre-release, or deployment-readiness checks.

<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->
## Review Areas

- Scope: confirm the change matches the stated goal and has no unrelated churn.
- Data: check migrations, backfills, irreversible writes, and compatibility.
- Flags: confirm rollout, kill switch, or config behavior when relevant.
- Rollback: describe how to revert safely and what state may remain.
- Observability: verify logs, metrics, alerts, and dashboards for risky paths.
- Documentation: every required document must describe the final verified behaviour. Missing, stale, contradictory, or misleading required documentation is a blocker and must be corrected in the same delivery rather than deferred.
- Evidence: distinguish `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, and `unknown`; only authoritative passed evidence for the exact current head satisfies a required gate.
- Review separation: confirm the final Technical Lead review is a distinct read-only phase over the pinned exact checked head, with no mutation authority while judging the candidate. Reviewer identity may be the same capable agent/model that implemented earlier work only after implementation has ended and the reviewer freshly re-derives its judgement from the issue/acceptance contract and current diff. A finding that requires mutation must be recorded against that exact head and ends the review phase. If the defect and smallest safe repair are clear, bounded, in scope, and already authorised, immediately resume implementation and repair it without conversationally blocking delivery; then refresh invalidated exact-head checks and start a new fresh review. Pause only for a genuinely new owner decision, material scope change, materially different repair choices, separately protected irreversible/costly action, or unresolved ambiguity. Different reviewer identity is preferred when available, but identity/model/human diversity is metadata rather than the independence gate.
- Validation: name post-release checks and expected signals.

## Output

Lead with blocking risks. Then list non-blocking observations and final release confidence. Do not classify stale required documentation, missing exact-head evidence, a review that was not a distinct read-only exact-head phase, or mutation performed during the purported final review as a non-blocking follow-up.
<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->