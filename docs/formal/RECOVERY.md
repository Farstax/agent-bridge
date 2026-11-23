# Recovery of issue #1278 investigation

This is incomplete recovered work, not merge-ready. The source was an uncommitted worktree based on `e435ce689e7fbe577026f9bd28adedf565edd427`. The recovery branch starts at `e0b6c1ab2f306e9471d01a78eb5352f82189f42c` (main at recovery); the two intervening commits touch none of the recovered files. The original worktree is preserved. No result below qualifies the recovery commit or current main: tests were run against the old base plus then-uncommitted changes, which cannot be identified by a single commit SHA. Working changes evolved between runs.

## Preserved evidence

- The latest full `./node_modules/.bin/vitest run test/rolloutHelper.test.ts --maxWorkers=1` against base `e435ce6` plus uncommitted candidate and timeout changes finished 134 passed, 1 skipped. Earlier full runs failed due to timeouts and a changed busy-WAL fixture; individual retries passed. This result is not a full test run of the recovered branch.
- `npm run typecheck` passed on base `e435ce6` plus then-uncommitted investigation changes; exact tree was not recorded.
- `./node_modules/.bin/vitest run test/runContinuation.test.ts test/rolloutContinuation.test.ts --maxWorkers=1`: 75 passed on base `e435ce6` plus then-uncommitted changes.
- Other focused results and TLC state counts, commands, mutations and caveats are recorded in README.md. These are finite abstractions, not implementation-refinement or liveness proofs. Counterexample descriptions are preserved; transient checker traces were not saved as durable artifacts.

## Incomplete and unverified

Repository-wide inventory and state/transition coverage are incomplete. Several models omit concurrency, crash, external effect, time, identity or terminal-correction behavior; see README for per-model limits. The caller-chain database-handle containment change is a candidate, not a proof of exclusivity: the scan is point-in-time and helper descendants are excluded. A disposable test demonstrated a caller-chain write after checkpoint invocation under the earlier behavior, not a production exploit. Review production handoff ancestry, later opens and independent safety qualification. Changes have not been independently reviewed or qualified on current main. No release or deployment was performed as part of recovery.
