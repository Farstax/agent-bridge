---
name: release-readiness-review
description: Use for `review it` and before merge/release/deploy to adversarially test the intended outcome, real runtime journey, transitions, authority, and exact candidate evidence.
---

# Release Readiness Review

This skill owns the `review it` command. The reviewer's job is to try to disprove readiness, not confirm the implementer's narrative.

## Independence

Use a **fresh, context-isolated, provider-native review agent with working repository read/search tools**. The reviewer must be able to inspect the exact PR head, related implementation, tests, and evidence itself. Prefer a different provider from the implementer; for this independent cross-provider review contract, **do not count a tool-free opinion or the implementer's own analysis as PASS**. Start from the issue/acceptance contract, current candidate diff/head, repository architecture/instructions, and evidence the reviewer chooses to inspect. Do not treat the implementer's reasoning, claimed root cause, or green tests as proof.

### Reviewer provider and model selection

The **implementing agent** launches an independent review through the provider's existing native tool/subagent interface. When the active provider cannot start a different provider's subagent, use Agent Bridge's outward ACP server through `npm run acp:review`; it is a one-shot client of the existing Bridge ACP runtime, not a second review service. Do not substitute a tool-free opinion for a repository reviewer, or add a review broker or provider hierarchy.

1. Choose a **different available provider** from the implementer: prefer **Claude / Opus** when implementing with Codex, and **Codex / Sol** when implementing with Claude. For any other implementing provider, prefer an available Claude or Codex reviewer. If one independent provider cannot start, another independently capable provider is acceptable; never silently review with the implementer's own provider.
2. Inspect the selected provider's currently **advertised model options** through its supported native/ACP model catalogue. For Claude prefer the `opus` model **class**, for Codex prefer `sol`. Choose the highest **unambiguous numeric model version** actually offered in that class; do not compare version strings lexically, treat a release date as a model version, construct an unadvertised ID, or retain a hardcoded historical version. This is a model preference, not an entitlement assumption.
3. If the class is not advertised, the catalogue cannot be inspected, or version ordering is ambiguous, **leave the model unpinned and use that same independent provider's default**. If a selected class model is rejected as unsupported or unavailable **before any review prompt is submitted**, retry once with that provider's default; do not replay a review after the provider may have started it. Never fall back to the unavailable model ID or to the implementing provider. Genuine provider authentication/capacity/tool availability failures may still block the review.
4. Start a **new, isolated review session** (not the implementing session) at the pinned candidate, with the provider's native **read/search** tooling available. For the ACP route, save the review contract and issue reference in a prompt file and run the helper from the active installed Bridge release, not from the candidate checkout:

   ```bash
   "$BRIDGE_CURRENT_RELEASE_DIR/bin/agent-bridge-review" --provider claude --head "$(git rev-parse HEAD)" --cwd "$PWD" --prompt-file /tmp/review-prompt.md
   ```

   Replace `claude` with the chosen independent provider. The helper runs the ACP server and evidence reader from the active installed release, requires the configured durable Bridge database, refuses same-provider review, locks the child Run to the reviewer with no fallback, and uses safe-mode permissions. The new ACP session, Bridge Run and telemetry remain in that database for later verification. It does not invoke `CLAUDE_COMMAND`, `agy models`, or another native CLI login probe. It uses the provider default because outward ACP does not expose the inner provider model catalogue. Supply the issue, exact PR head, repository instructions, and review objective; the reviewer gathers its own evidence. The helper qualifies only a completed Bridge Run from the requested provider, completed repository read and search tool calls, and one exact-head result marker. Do not authorize code edits, commits, merges, infrastructure changes, or deployments through this review invocation.
5. Record the actual independent provider, returned model or `provider-default`, Bridge Run and ACP session identifiers, reviewed head, read/search tool kinds, and PASS/findings. The command distinguishes launch, ACP authentication, unsupported-model, capacity, missing-tool, and review-result failures. Native CLI sign-in failures do not classify ACP availability. If independent review cannot read the repository or cannot complete, report the blocker; **never grant PASS or bypass the merge gate**.

Representative selection checks: a Codex implementation with advertised Opus 5.5 and 5.6 selects 5.6; a Claude implementation with Sol 6 and 6.1 selects 6.1; missing/opaque class options or a pre-prompt model entitlement rejection use the *independent* provider default; a tool-free opinion alone never qualifies as review.

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

When the affected journey crosses owners or execution environments (such as host to guest, staged release to active process, or persisted metadata to service), trace the consequential handoff end to end. Distinguish requested or recorded success from the effective running state; verify the relevant actor/permissions, any required active/staged/rollback state, and downstream identity/health read-back. An upstream stage succeeding is not proof that the next owner completed its work. Keep the evidence limited to boundaries the change can affect.

Treat tests/CI as evidence. Challenge a mock, synthetic request, source-shape assertion, or helper-only test when it does not reach the consequential production boundary.

## Simplification changes

When a change reduces instructions, context, skills, or verification, prove the simplification against a small representative task set before returning PASS. Prefer existing evidence or manual fixtures: confirm required skills/capabilities and relevant checks are still selected, and compare prompt/context size or an existing proxy where available. Token or process savings count only when capability/check selection does not regress. Do not add persistent retrieval, selection, scoring, or evaluation machinery unless this comparison exposes a concrete gap that existing owners cannot address.

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

For a merged push, reuse a prior PR qualification only when the repository automation proves that the merged commit and the qualified PR candidate have identical Git trees and that the source exact-head verification job completed successfully. Commit identity and tree identity are authoritative. If the proof is missing or unclear, run the complete main or release qualification. Refresh environment-bound evidence when the host, dependency set, provider, or resource envelope changes.

Boundary evidence must cover the transitions that can fail in production. For persistent state and provisioning, include fresh setup, existing-state convergence, restart or reconciliation, rollback, interruption or retry, and a true second run when those paths are relevant. For installs, systemd, PATH, or environment changes, verify the effective process state. For expensive install or deployment work, use the smallest supported resource envelope when resource pressure affects correctness.
