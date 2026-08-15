---
name: requirements-to-acceptance
description: Use when turning product requests, bug reports, or vague implementation asks into scoped requirements, assumptions, non-goals, acceptance criteria, and verification steps for software work.
---

# Requirements To Acceptance

Use this skill before implementation when the requested outcome is ambiguous, cross-functional, user-facing, or likely to affect multiple modules.

<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->
## Workflow

1. Restate the goal in one or two plain sentences.
2. Identify assumptions, constraints, and known unknowns.
3. Separate goals from non-goals.
4. Convert the goal into acceptance criteria that can be tested or manually verified.
5. When one request is decomposed into multiple issues, assemble the complete proposed issue bundle before mutation and audit it against one canonical invariant table. Check implementation dependency order separately from runtime phase order, ownership, state/lifecycle authority, permissions, persistence, GitHub authority, and cross-system authority.
6. For any proposed sequential step, ask what exact output from the earlier step the later step consumes. If nothing is consumed, it is not a real dependency — consider safe provider-native parallel execution instead. Keep real data, mutation, ownership, verification, review, or safety dependencies in order.
7. Name the verification steps before implementation begins.

Ask a concise question only when a missing answer would make a reasonable implementation risky. Otherwise, state the assumption and continue. Do not mutate issue records until a multi-issue bundle is internally consistent.

## Output Shape

Prefer this structure when a written requirements pass is useful:

- Goal
- Assumptions
- Non-goals
- Acceptance criteria
- Verification
- Open questions

Keep the result short enough to guide implementation without becoming a spec theater detour.
<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->
