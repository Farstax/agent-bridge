---
name: code-simplification
description: Use when the user explicitly asks to simplify, clean up, or refactor existing code without changing behavior, or when an already-authorized change reveals a concrete unnecessary-complexity defect. Do not run as an automatic review or ship gate.
---

# Code simplification

Make existing code easier to understand and maintain **without changing what it does**. Simpler means fewer concepts and responsibilities, not necessarily fewer lines. This is a bounded refactoring operation, not a code-review verdict or new development lifecycle.

Adapted from Addy Osmani's `code-simplification` Skill (MIT). See `NOTICE.md` and `LICENSE` for source and attribution.

## When to use

- The user asks to simplify/refactor existing code.
- Within already-authorized implementation, a specific duplication, pass-through layer, unnecessary abstraction, or confusing control flow prevents a clear smallest fix.
- A reviewer identifies a concrete simplification that is in scope for the current change.

Do **not** automatically run after every feature, bug fix, `review it`, or `ship it`. Do not turn a question about refactoring into permission to change code. If no actual complexity improvement is supported by evidence, say so and leave the code alone.

## Method

1. **Understand before editing.** Read relevant repository instructions, the implementation, callers and current tests. State the observable contract: inputs, outputs, side effects, error conditions, ordering, concurrency, security/authority boundaries, and performance constraints.
2. **Name the cost.** Identify a concrete source of unnecessary complexity. Prefer deleting obsolete code, reusing an existing owner, merging truly duplicate paths, and flattening gratuitous indirection. Preserve meaningful boundaries and names. A short function is not automatically a better module.
3. **Choose the smallest refactor.** Limit changes to the requested code or directly affected neighbors. Follow local naming and architecture. Do not introduce a framework, configuration layer, compatibility shim, helper or new abstraction just to describe the old code differently.
4. **Protect behavior.** Use existing focused tests as the baseline. Add a narrow regression only when the relevant behavior is not already protected. For an actual behavior change, defer to `red-green-refactor-tdd` rather than presenting it as pure simplification. Preserve public interfaces and observable errors, side effects, timing/order and permissions.
5. **Make one coherent edit and verify.** Run the focused tests, typecheck or integration boundary relevant to the change. If a comparison is ambiguous, dependencies are unavailable, or the test would require production access, stop short of claiming equivalence. Escalate to the repository's existing CI/review route when shipping is authorized.
6. **Report compactly.** Explain the complexity removed, why behavior is preserved, tests actually run, and any unverified risk. Never claim improvement just because fewer lines were written.

## Decline unsafe simplification

- Do not merge distinct authority, cancellation, retry, persistence or delivery owners merely because their code looks similar.
- Do not inline meaningful domain concepts or remove compatibility that still has a real caller.
- Do not trade verified performance for aesthetically simpler code without measurement.
- Do not hide a failing test, alter expected results, weaken error paths, or change public contracts to make refactoring easier.
- Do not perform drive-by cleanups outside the authorized work.

## Existing owners remain authoritative

`systematic-debugging` diagnoses defects; `requirements-to-acceptance` establishes scope; `red-green-refactor-tdd` owns behavior changes; `release-readiness-review` alone owns `review it`, exact-head adversarial readiness and pre-merge conclusions; `delivery-directives` owns ship/release/deploy authorization. Code simplification adds **none** of those phases or permissions.
