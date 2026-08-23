---
name: release-readiness-review
description: Use for `review it` and before merge/release/deploy to adversarially test the intended outcome, real runtime journey, transitions, authority, and exact candidate evidence.
---

# Release Readiness Review

This skill owns the `review it` command. The reviewer's job is to try to disprove readiness, not confirm the implementer's narrative.

## Independence

Prefer a fresh/context-isolated execution when available. Start from the issue/acceptance contract, current candidate diff/head, repository architecture/instructions, and evidence the reviewer chooses to inspect. Do not treat the implementer's reasoning, claimed root cause, or green tests as proof.

Before reading the implementation in detail, independently restate the intended observable outcome, actor/resource/authority, and important non-goals. If that contract is wrong or incomplete, report it rather than reviewing the wrong solution more carefully.

## Adversarial review

Inspect only areas relevant to the change, but trace the real journey far enough to challenge the selected boundary:

- complete user/runtime path and affected change surfaces;
- sibling/provider/caller implementations of the same invariant;
- production-shaped external contract when local simulation cannot prove it;
- persistence, process identity, PATH/env/executable/service, installation, restart, and reconciliation where affected;
- security/identity/credential/permission path:
  `actor -> authentication -> selection -> durable state -> credential -> target -> operation`;
- incorrect product assumptions, unintended scope expansion, weakened compatibility, or hidden coupling.

For persistent state, startup, provisioning, deployment, or reconciliation changes, explicitly select and qualify the relevant supported transitions:

- fresh state -> candidate;
- existing supported production state -> candidate;
- restart/reconcile on candidate;
- rollback after candidate has touched persistent state.

Only require transitions that the change can actually affect.

Treat tests/CI as evidence. Challenge a mock, synthetic request, source-shape assertion, or helper-only test when it does not reach the consequential production boundary.

## Findings

Return either **PASS** or deterministic findings. Each finding should contain only what makes it actionable:

- severity;
- violated invariant;
- concrete consequence;
- supporting location/evidence.

Avoid praise, style nits, generic summaries, speculative future work, or repeating CI evidence already recorded elsewhere.

A finding that requires mutation ends that review of the pinned head. The implementer repairs the issue, runs focused validation, and `review it` is rerun against the new head. Do not treat a reviewer that is simultaneously editing the candidate as the final approval.

## Qualification placement

Run `review it` before the expensive final full-suite qualification where practical. After the review passes, the final merge-candidate head must satisfy the repository's required exact-head checks. A subsequent head change invalidates the review or check evidence whose conclusions depend on the previous head.

For release/deploy readiness, additionally inspect the merged delta, relevant migrations/rollback, release identity/artifact provenance, and post-release/deploy signals without reopening already-reviewed implementation work absent a concrete integration risk.
