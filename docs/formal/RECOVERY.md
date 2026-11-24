# Recovery of issue #1278 investigation

This is incomplete recovered work, not merge-ready. The source was an uncommitted worktree based on `e435ce689e7fbe577026f9bd28adedf565edd427`. The recovery branch starts at `e0b6c1ab2f306e9471d01a78eb5352f82189f42c` (main at recovery); the two intervening commits touch none of the recovered files. The original worktree is preserved. No result below qualifies the recovery commit or current main: tests were run against the old base plus then-uncommitted changes, which cannot be identified by a single commit SHA. Working changes evolved between runs.

## Preserved evidence

- The latest full `./node_modules/.bin/vitest run test/rolloutHelper.test.ts --maxWorkers=1` against base `e435ce6` plus uncommitted candidate and timeout changes finished 134 passed, 1 skipped. Earlier full runs failed due to timeouts and a changed busy-WAL fixture; individual retries passed. This result is not a full test run of the recovered branch.
- `npm run typecheck` passed on base `e435ce6` plus then-uncommitted investigation changes; exact tree was not recorded.
- `./node_modules/.bin/vitest run test/runContinuation.test.ts test/rolloutContinuation.test.ts --maxWorkers=1`: 75 passed on base `e435ce6` plus then-uncommitted changes.
- Other focused results and TLC state counts, commands, mutations and caveats are recorded in README.md. These are finite abstractions, not implementation-refinement or liveness proofs. Counterexample descriptions are preserved; transient checker traces were not saved as durable artifacts.

## Incomplete and unverified

Repository-wide inventory and state/transition coverage are incomplete. Several models omit concurrency, crash, external effect, time, identity or terminal-correction behavior; see README for per-model limits. The caller-chain database-handle containment change is a candidate, not a proof of exclusivity: the scan is point-in-time and helper descendants are excluded. A disposable test demonstrated a caller-chain write after checkpoint invocation under the earlier behavior, not a production exploit. Review production handoff ancestry, later opens and independent safety qualification. Changes have not been independently reviewed or qualified on current main. No release or deployment was performed as part of recovery.

## Recheck of recovered models

On recovered commit `e3e80e81f29b7f065902e4cd0381c4b155d4c289`, all 14 checked-in configurations completed with exit code 0 using TLC `2026.11.19.180144` (revision `bc1b506`), Java Temurin 21.0.13.1, one worker, and `tla2tools.jar` SHA-256 `fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713`. Generated / distinct states:

| Model | Generated | Distinct |
| --- | ---: | ---: |
| AutonomousGoal | 13 | 13 |
| AutonomyReconcile | 6 | 5 |
| CapacityWait | 23 | 18 |
| EventReceipt | 34 | 17 |
| LateProviderResult | 7 | 6 |
| MultiRoleFence | 36 | 20 |
| OrdinaryContinuation | 121 | 80 |
| OutputDelivery | 27 | 21 |
| QueueStop | 106 | 39 |
| RolloutFence | 43 | 24 |
| RolloutRecovery | 134 | 34 |
| RunTerminal | 4 | 4 |
| ScheduledCorrelation | 717 | 170 |
| SlackReadiness | 25682 | 1752 |

From this directory, with the named verified jar supplied locally:

```sh
for config in *.cfg; do
  model=${config%.cfg}
  java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers 1 -config "$config" "$model.tla" || exit
done
```

On a temporary copy of `OrdinaryContinuation.tla`, replacing `t \in Tokens \ used` with `t \in Tokens` caused TLC exit 12 and a `NoRetiredClaim` counterexample (25 generated, 23 distinct). The committed model was not modified. These are finite abstraction results, not evidence of continuous SQLite exclusion or implementation refinement. Recheck the exact final candidate after changes.
