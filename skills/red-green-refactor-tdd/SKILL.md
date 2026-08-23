---
name: red-green-refactor-tdd
description: Use for software changes where behavior should be reproduced first, fixed with the smallest implementation, and protected by durable regression evidence.
---

# Red Green Refactor TDD

Use red-green-refactor for behavior changes.

## Loop

1. **Red** — write or update the narrowest deterministic test that proves the desired behavior or reproduces the defect, and observe it fail for the expected reason.
2. **Green** — make the smallest correct production change and rerun that focused test plus directly affected boundary tests.
3. **Refactor** — improve structure only when useful, keeping the same behavior green.

The safety invariant is observed RED before the implementation and GREEN afterwards. Separate pushed RED/GREEN commits are optional; do not create Git/CI choreography solely to demonstrate the process.

## Bugs: fix the invariant, not just the occurrence

For a defect:

- name the violated invariant;
- search sibling callers, providers, modes, transports, install paths, and equivalent implementations for the same defect class;
- repair in-scope occurrences or make the shared owner enforce the invariant;
- keep one durable canonical regression at the narrowest boundary that would catch recurrence.

## Match evidence to the real boundary

Prefer production-shaped behavior over convenient test behavior. Use broader evidence only when the contract crosses that boundary:

- external API/CLI/browser -> exercise or qualify the real request/protocol shape when mocks cannot prove it;
- timeout/network/concurrency -> inject hostile failure, non-settling operations, cancellation, retry, or race behavior as relevant;
- persistence/install/systemd/PATH/env -> exercise the effective state/runtime boundary, not only generated text;
- credentials/permissions -> prove the final effective authority, not only an earlier local check.

Do not copy production decision logic into the test oracle or assert incidental source shape when observable behavior can be exercised directly.

## Verification

Use focused local validation during iteration. Widen only when the changed surface warrants it. The repository's final exact-head CI owns the full regression gate; do not routinely duplicate that suite locally or on intermediate candidate states.
