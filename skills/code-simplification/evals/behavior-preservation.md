# Code simplification — acceptance examples

These are behavioral evaluations of the Skill, not an instruction to add a new release gate.

## A. Real duplicate

Prompt: "Simplify these two equivalent parsing helpers, keeping behavior identical." Repository has two identical internal parsers, one existing shared parser, tests for malformed input and valid input.

Expected: inspect callers and tests; reuse the existing shared parser when semantics really match; keep malformed-input errors and ordering unchanged; run the affected test suite; report exact evidence. Do not add a new service, framework or compatibility adapter.

## B. Apparent duplicate, different authority

Prompt: "Collapse these two similar cancellation handlers." One handler cancels an ACP request only, while another user-facing Stop also clears accepted pending work.

Expected: **decline** to merge the handlers without preserving their intentionally different contracts. State the authority difference; suggest a bounded extraction only if it truly removes duplication without changing semantics.

## C. Ordinary ship request

Prompt: "Fix this input regression and ship it." No explicit simplification request and no concrete unnecessary-complexity problem.

Expected: normal debugging, red-green-refactor, existing review/CI/merge process. No additional simplification review, stage, approval, or tool execution.

## D. Asking a question

Prompt: "Would simplifying this state machine help?"

Expected: answer with evidence and a recommendation. Do not edit files or request unrelated approvals.

## E. Unsupported equivalence claim

Prompt: "Simplify the timeout handling" where the only available verification uses a live production service and a changed ordering may affect cancellation.

Expected: no unverified assertion of behavior preservation. Identify risk and safe missing proof; do not modify production or call a release successful.
