# OSS #1278 — critical state-owner and transition correspondence

> **Status: incomplete and not merge-qualified.** This mapping is an implementation
> audit, not a TLA refinement proof. `RECOVERY.md` records the recovered-head model
> recheck; it does not qualify later changes or prove production correspondence.

## Boundaries that must stay distinct

- **Logical task / Workstream:** the accepted user objective and its durable origin; completing a provider Run need not complete the objective.
- **Run:** one bridge-owned execution, persisted in `bridge_runs`; ordinary terminal writers are guarded SQLite updates. A Run may involve provider attempts and fallback. Autonomous disposition reconciliation has a deliberately separate `done` → `failed` correction.
- **Provider attempt:** one invocation under a Run, with provider-specific session and process authority. A failed attempt need not be a terminal Run.
- **Queue receipt / lane claim:** durable `pending_messages` and lease/lock ownership. A queued message is not a Run; losing a claim is not evidence of a provider effect.
- **Continuation:** one persisted future wake with its own claim token, lifetime and successor correlation. A capacity wait is not an ordinary fresh continuation.
- **Process:** OS-owned provider descendants and their independently verified liveness/termination; a database status is not proof of process death.
- **Delivery:** an external message or upload with partial/in-flight side effects. Stop can fence the next send, not undo an already-started send.

## Critical model actions and their real implementation owners

| Model / important actions | Authoritative code and guard | Implementation test owner | Not proven by the abstraction |
| --- | --- | --- | --- |
| `RunTerminal`: `Finish(done/failed/cancelled)` | `RunRepository.updateRunCompleted/Failed/Cancelled` in `src/repositories/runRepository.ts`; each `WHERE status = 'running'` CAS. | `test/db.test.ts` terminal-writer order; `test/eventStore.test.ts` | Autonomous `done` → `failed` correction, multiple processes, external effects |
| `LateProviderResult`: `Stop`, `Return`, `Settle` | `BridgeOutwardAcpPromptExecutor.cancel/cancelRun/execute` in `src/acpServer/execution.ts`; separate cancellation/final-publication authority. | `test/acpOutwardCancellationRace.test.ts` gated late success | Earlier streaming, remote process shutdown, irrevocable provider side effects |
| `QueueStop`: `Acquire`, `Claim`, `LoseLane`, `Recover`, `Admit`, `Stop`, `Finish` | `src/executionLaneCoordinator.ts` ingress `preparing/claimed/aborted`, durable `src/db.ts` queue/locks and `src/acpServer/execution.ts` Stop fence; no single in-memory authority. | `test/executionLaneCorrectness.test.ts`, `test/executionLaneCoordinator.test.ts`, `test/acpOutwardQueueDrain.test.ts` | Lease expiry and crash between SQL claim, Stop and provider submit |
| `OrdinaryContinuation`: `Fence`, `Claim`, `Admit`, `Reclaim`, `Stop`, `Expire`, `Settle` | `src/runContinuation.ts`: `claimDueRunContinuation`, `linkRunContinuationRun`, `cancelPendingRunContinuation`, `reconcileRunContinuations`, `settleRunContinuation`; token/expiry checks remain at SQLite transaction owner. | `test/runContinuation.test.ts`, `test/rolloutContinuation.test.ts` | Identity/lease/queue cross-product, fairness, effects after admission |
| `CapacityWait`: `Claim`, `Admit`, `Finish`, `ReceiptLost`, `Complete`, `Fail`, `Retry`, `Stop`, `Expire` | `src/runContinuation.ts`: `claimDueRunContinuation`, `capacityCompletionProven`, `linkCapacityContinuationRun`, `requeueClaimedCapacityWait`, `requeueProvenOutwardCapacityRejection`, `scanRunContinuations`, `settleRunContinuation`. | `test/acpOutwardCapacityRecovery.test.ts`, `test/runContinuation.test.ts` including late expiry-versus-failure regression added after recovery | Missing receipt is ambiguous; no provider effect exactly-once guarantee; notification callback races need executable tests |
| `RolloutFence`: `Fence`, `Stop`, `Contain`, `Offline`, `Activate`, `Rollback`, `Release` | `src/idleUpgradeAdmission.ts` role fence; `scripts/rollout-agent-bridge.sh` writer scan, stop, WAL checkpoint, backup/migration, rollback and proof gates. | `test/idleUpgradeAdmission.test.ts`, `test/rolloutHelper.test.ts` | Writer exclusion is now a mode-000 fence set before the holder scan and re-verified after every offline tool run (`test/rolloutHelper.test.ts`: late writer, respawner, caller late-open, busy WAL, rollback). Not excluded: root, or a same-user process that opens the database inside a single tool invocation (detected after the run and refused, not prevented); PID reuse between observation and signal |
| `MultiRoleFence`: `Acquire`, `Deny`, `Admit`, `Release`, `CleanupFailure`, `Offline` | `tryAdmitIdleUpgradeRoles`, `releaseIdleUpgradeRoles`, `recoverIdleUpgradeRoles` in `src/idleUpgradeAdmission.ts`; exact token required for each role. | `test/idleUpgradeAdmission.test.ts` swapped role tokens and partial-fence scenarios | Real OS owner/boot identity, failed release and live DB writer |
| `RolloutRecovery`: `Arm`, `Fence`, `Abort`, `Interrupt`, `Audit`, `Release`, `Claim` | `armInterruptedWorkstreamRecovery` / `tryAdmitIdleUpgrade` in `src/idleUpgradeAdmission.ts`; `provenPostRolloutAudit` / `claimDueRunContinuation` in `src/runContinuation.ts`. | `test/rolloutContinuation.test.ts`, `test/rolloutLifecycle.test.ts` | Observed process absence is not proof against reappearance; readiness and audit identity must be independently checked |
| `AutonomousGoal`: `Claim`, `Continue`, `Terminal`, `Cancel` | `src/autonomousGoalRuntime.ts`: `claimWakeAndRun`, `reconcile`, `cancelAutonomousGoal`; goal state `active/complete/blocked/cancelled/budget_exhausted`. | `test/autonomousGoalRuntime.test.ts`, `test/autonomousGoalCancellationFence.test.ts` | Budget/wake/process concurrency, durable effect idempotency |
| `AutonomyReconcile`: `ProviderDone`, `CancelRun`, `ReconcileMissing`, `ReconcileCancelled` | `src/autonomousGoalRuntime.ts` `reconcile` and `recoverUnreconciledWake`; missing disposition can correct technical `done` to `failed`, never `cancelled`. | `test/autonomyDispositionContract.test.ts`, `test/autonomousGoalCancellationFence.test.ts` | Full disposition cases, aborted process state and multi-connection interleavings |
| `EventReceipt`: `Receive`, `Duplicate`, `Claim`, `Link`, `Finish` | `src/repositories/eventReceiptRepository.ts` `admitReceipt` owns the `UNIQUE(idempotency_key)` `ON CONFLICT DO NOTHING` insert; `createReceipt` now delegates. `claimDispatch`, `linkRun`, `finish` own status CAS. | `test/telegramPollAdmission.test.ts`, `test/slackIngress.test.ts`, `test/db.test.ts` cross-connection two-API regression | External effect exactly once, retention expiry and cross-process crash/effect ambiguity |
| `ScheduledCorrelation`: `Link`, `FailEvidence`, `Advance` | `src/scheduledRunCorrelation.ts` `linkScheduledOccurrenceRun` and `markScheduledOccurrenceFailed` within transaction and settings value CAS. | `test/scheduledRunCorrelationEngine.test.ts`, `test/scheduledRunCorrelationHardening.test.ts` | Completed Run cannot be rebound; missing Run may still have produced a side effect |
| `OutputDelivery`: `Start`, `Stop`, `Finish`, `Settle` | `src/fileOutput.ts` `uploadOutputFiles` `canPublish` checks and retention marker functions. | `test/fileOutput.test.ts`, `test/fileOutputRetentionInvariant.test.ts` | Transport send already in-flight, crash before deletion/marker, TTL and filesystem failures |
| `SlackReadiness`: socket/flush/restart/age | `src/slackStatus.ts` `SlackStatusWriter.transition/stop` and `isSlackStatusCurrent` identity/generation/time check. | `test/slackConfigStatus.test.ts` | Connected observation is not a live socket, cross-process status ordering and network connectivity |

## Other inventoried ownership (deliberately not one model per enum)

| Owner | Classification / reason not to add a new model here |
| --- | --- |
| `src/rolloutLifecycle.ts` | Process/claim `live-correlated/stale-unowned/ambiguous` classification feeds rollout evidence. Its process identity observations require real-process tests, not another enum-only model. |
| `src/providers/recoveryVerdict.ts` and `src/providers/qualificationStatus.ts` | Provider recovery decisions and qualification evidence are separate domain observations, not a reason to merge capacity and ordinary continuation state. Explicit coverage of persisted-evidence races remains open. |
| `src/runOutcome.ts`, `src/acpServer/execution.ts` outward Workstream status | Exchange completion and objective outcome are distinct. Some outward statuses are projections, not independent durable transition owners. |
| `src/acp/subagentActivity.ts` | Subagent spawned/completed/failed/interrupted: separate observer; verify owner before considering additional modeling. |
| Legacy worker/task tables | Not an active runtime state owner after retirement migrations. Do not resurrect a generic Task or another queue. |

## Narrow production changes on this continuation branch

1. `EventReceiptRepository.createReceipt` now delegates to `admitReceipt`: removes a duplicate read-then-insert branch and uses the existing SQLite unique-key admission authority for both APIs. `test/db.test.ts` checks both call orders, distinct SQLite connections, preserved in-flight/terminal status and no duplicate rows. The duplicate/retention interleaving is covered by a two-connection test; it does not establish exactly-once effects.
2. `settleRunContinuation` now admits writes only from `pending` or `claimed`; once `failed`, `completed`, `cancelled` or `expired`, a later expiry cannot overwrite terminal evidence. Expiry reclaims in `scanRunContinuations` also re-read the live state, require a capacity wait and reject a terminal value before creating an expiry claim. `test/runContinuation.test.ts` injects a competing failure during awaited expiry notification and separately settles between a stale scan candidate and its transactional re-read. Focused regression evidence must be refreshed for the final candidate.
3. Receipt insertion and duplicate lookup now share an immediate transaction, preventing retention from deleting the selected duplicate between statements. `test/db.test.ts` forces that ordering on two SQLite connections. Run ingress likewise creates its receipt and links its Run in one immediate transaction; `test/runIngress.test.ts` covers rollback on admission failure, duplicate authority/scope and a two-process admission race. An existing unlinked receipt remains ambiguous and fails closed; no external effect deduplication is inferred.
4. During writer termination, `contain_sqlite_writers` rechecks caller identity and ownership before escalation. A disposable process-tree test covers a caller opening the database during termination. This does not protect against PID reuse between observation and signalling and is not continuous writer exclusion.
5. Writer exclusion: `contain_sqlite_writers` sets every managed database and sidecar to mode 000 (original modes in `sqlite-fence-modes.json`) before scanning holders, so a process opening after the scan is denied. Each `rollout-db.ts` run lifts the fence for itself and restores it on exit; `run_db_tool` then re-scans holders and fails closed if one appeared in that window. Backup records original modes; the fence is released just before service start and last in `on_exit`. Regressions: independent late writer, respawning writer and caller late-open in `test/rolloutHelper.test.ts`.
5. Writer exclusion: `contain_sqlite_writers` sets every managed database and sidecar to mode 000 (original modes recorded in `sqlite-fence-modes.json`) before scanning holders, so a process that opens after the scan is denied. Each `rollout-db.ts` invocation lifts the fence for its own run and restores it on exit; `run_db_tool` then re-scans holders and fails closed if any appeared inside that window. Backup records the original mode; the fence is released immediately before service start and last in `on_exit`. Regressions: independent late writer, respawning writer, caller late-open (not killed) in `test/rolloutHelper.test.ts`.
5. **Test consolidation:** the old in-memory `createEventReceipt` duplicate test was removed only after transferring both of its assertions (same ID on repeated create, and lookup by idempotency key) into the new two-connection regression. No process, WAL, Stop, rollback or transport integration test was removed. No shared state-machine runtime, new table, public API or CI framework was introduced.

## Blockers to merge

1. **SQLite writer containment:** addressed by the fence in change 5. Residual, unproven: root-privileged writers; a same-user process opening inside one tool invocation (detected afterwards, not prevented); PID reuse between observation and signal. Not modelled in TLA+.
2. **Formal scope:** rerun all 14 `*.tla`/`*.cfg` pairs from `docs/formal` with the pinned trusted TLC 2.19 (or record a deliberate updated version), state counts, bounds and output; deliberately remove a meaningful guard in a disposable copy, save counterexample and restore pass. Models are bounded safety abstractions, not refinement or liveness proofs.
3. **Exact-head implementation tests:** run `test/db.test.ts`, `test/runContinuation.test.ts`, and each mapped targeted suite including actual process/SQLite, Stop, upload and rollback fixtures; then repository `npm run typecheck`, `npm run qualify:local` and required hosted checks. Record the **same final head SHA** for all gates.
4. **Evidence/measurement:** record full-suite baseline/final test count, runtime and touched-file source LOC; retain unique real-process and transport coverage, and defer unrelated broad test subtraction to #462. Independently review changed lines and correct findings before declaring ready.

### Reproduction starting point

```sh
git switch work/1278-explicit-state-machines
npm ci
npm run typecheck
./node_modules/.bin/vitest run test/db.test.ts test/runContinuation.test.ts --maxWorkers=1
( cd docs/formal && for module in *.tla; do name=${module%.tla}; java -XX:+UseParallelGC -cp /absolute/path/to/tla2tools.jar tlc2.TLC -workers 1 -config "$name.cfg" "$module" || exit; done )
npm run qualify:local
```

Use a verified `tla2tools.jar`; see `RECOVERY.md` for recovered-head results and the checker hash. Rollback/WAL races and full qualification remain open.
