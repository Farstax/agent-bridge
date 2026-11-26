# Formal verification of critical OSS state machines

This is the **living engineering guide** for the bounded TLA+ models introduced in [#1278](https://github.com/Farstax/agent-bridge/issues/1278). The [transition map](TRANSITION-MAP.md) identifies actual code/transaction owners, implementation tests and unproven boundaries. The historical investigation below remains evidence only for its **stated revisions**.

## When to check or maintain models

For changes to critical durable or concurrent lifecycle behaviour—Run/Stop, claims/receipts, continuations, stale owner fencing, restart, rollout/rollback or ambiguous external effects—start with the transition map and current source. Inspect the relevant model and its assumptions. **Update a model and config only when its represented transitions, guards or invariants change.** For relevant code behaviour outside its abstraction, retain real implementation tests and note the gap. Do not model every enum, presentation state or unrelated refactor.

## Focused verification practice

1. Identify the authoritative persisted/process owner. Distinguish task, Run/attempt, queue receipt, continuation, process and external delivery. Specify meaningful legal transitions, guards, cancellation/timeout, crash/restart and effect boundaries.
2. Prefer the existing small `.tla` + finite `.cfg` pair. Record checked safety invariants, assumptions and excluded behaviour. Temporarily mutate a consequential guard **when informative**, confirm TLC finds the intended counterexample, then restore the specification.
3. Run TLC from this directory with a trusted local tools JAR (see [recovered checker provenance](RECOVERY.md)):

   ```sh
   java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers 1 \
     -config OrdinaryContinuation.cfg OrdinaryContinuation.tla
   ```

   Run each **affected** configuration and record checker identity, commit SHA, finite configuration, state counts and violations in the PR evidence. No new CI job or mandatory model for every change.
4. Map **model action → actual guard/SQL or OS boundary → executable regression → limitation** in [TRANSITION-MAP.md](TRANSITION-MAP.md). Keep real-process, SQLite/WAL, provider, Stop, rollback, restart and delivery tests when a model cannot prove those boundaries.
5. Existing [TDD and release-readiness guidance](../../AGENTS.md) owns implementation and review. Bounded TLC does **not** prove implementation refinement, liveness, continuous OS exclusion or exactly-once external effects. Do not create a second state manager, approval gate or verification framework.

## Historical investigation and model notes

For the maintained model → production-owner → executable-test mapping, see
[TRANSITION-MAP.md](TRANSITION-MAP.md). The initial results below document the
pre-merge investigation; they do not qualify subsequent revisions.

This inventory is a starting point, not a claim of exhaustive repository coverage. The initial source inventory targeted main `07ca07770a99af91c4461fb3fed82687ea6cb5cb`. The worktree has since advanced to `e435ce689e7fbe577026f9bd28adedf565edd427`; relevant targeted tests are identified below, and the inventory and all tests have not yet been requalified for that head. The first test run below was on `7793aed` and is not exact-head evidence. The separate uncommitted rollout-recovery candidate is not included.

| Boundary | Evidence | States / key transitions | Remaining work |
| --- | --- | --- | --- |
| Ordinary continuation | `src/runContinuation.ts`, `test/runContinuation.test.ts`, `test/rolloutContinuation.test.ts` | pending, claimed, completed, failed, expired, cancelled; claim, queue, admit, settle, cancel, expiry and restart reconciliation | Model queue correlation, leases, exact token generations, Stop races, provider identity and the pre-fence recovery arm plus audited post-rollout claim now present on main; map each transition to tests. |
| Event receipt (Telegram/Slack) | `src/repositories/eventReceiptRepository.ts`, `src/db/telegramReceiptsMigration.ts`, `src/db/slackReceiptsMigration.ts` | received, dispatching, run_created, completed, failed, cancelled, ambiguous; idempotency, claim, link and settlement | Model retention, crashes and queue/provider boundary; autonomous receipts have a different owner and state set. |
| Pending message queue | `src/db/legacyBaselineMigration.ts`, `src/executionLaneCoordinator.ts` | queued, claimed, retired; ownership and lock fencing | Model claim/lease recovery, Stop and correlation to Runs. |
| Reconciliation audit | `src/db/reconciliationAuditMigration.ts`, `src/db.ts` | started, completed; exact identity and containment evidence | Model transaction abort, failure and audit cardinality; distinguish proof from assertions. |
| Capacity continuation | `src/runContinuation.ts`, `test/acpOutwardCapacityRecovery.test.ts` | ordinary states plus retained receipt, claimed retry, successor correlation and capacity expiry | Separate model: do not treat missing receipt as completion or replay ambiguous submission. |
| Rollout admission | `src/idleUpgradeAdmission.ts`, `test/idleUpgradeAdmission.test.ts` | idle, deferred busy, unknown, admitted/fenced; multi-role partial failure, release and recovery | Model role fences, exact token, all writers, offline operation, crash and rollback. |
| Process/lane ownership | `src/runOwnedProcesses.ts`, `src/executionLaneCoordinator.ts` | live, absent, ambiguous and live/stale locks | Model PID identity and descendant containment; ambiguous is not absent. |
| Run outcome and outward projection | `src/runOutcome.ts`, `src/acpServer/execution.ts` | complete, continue, blocked; running, waiting, attention, failed, cancelled, expired, idle | Trace projection versus durable state and end-turn. |
| Autonomous goals | `src/autonomousGoalRuntime.ts`, `src/autonomousExecutiveLoop.ts` | active, complete, blocked, cancelled, budget exhausted; cycle progress/complete/blocked | Inventory transition guards and tests. |
| ACP provider subagents | `src/acp/subagentActivity.ts` | spawned, completed, failed, interrupted | Identify whether this is a projection or an authority; map tests. |
| Slack connection | `src/slackStatus.ts` | connecting, connected, reconnecting, disconnected, reconnect required, failed | Inspect event ordering, reconnect and tests. |
| Provider qualification evidence and health | `src/providers/qualification.ts`, `test/acpQualificationBoundaries.test.ts` | checks pass, fail, not applicable, unsupported, unauthenticated, capacity exhausted, model unavailable, transient; overall pass, degraded, fail; health green, amber or red depending on evidence validity and identity | Audit persisted evidence replacement and runtime/candidate identity, stale and malformed evidence, check aggregation and transitions; test mapping and model pending. |
| File output and retention | `src/fileOutput.ts`, `test/fileOutput.test.ts`, `test/fileOutputRetentionInvariant.test.ts` | complete, partial, cancelled or unsupported delivery; retention marker missing, unavailable, invalid or valid | Audit partial delivery, cancellation and marker expiry/cleanup across crashes and retries; model and transition mapping pending. |

## Bounded ordinary continuation model

The model is a bounded specification of one ordinary outward continuation, an abstract fence, a single successor and two fresh claim tokens. Two abstract providers distinguish the originating provider from the stored preference (which may differ after fallback). A deliberate selection is separate evidence; switching back does not clear it. The execution provider must be the origin absent a deliberate switch, otherwise the selected provider, and must belong to the configured set and satisfy an explicit lock. Configuration can change before admission; the model freezes that decision after admission. A disallowed provider can settle as unresolved, never complete. A `continue` disposition settles the wake, not the objective.

The existing token, Stop, fence and no-false-completion invariants remain. `NoUnauthorisedAdmission` and `ProviderSelectionRespected` check the admission-time provider. `ValidAdmissionEnabled` requires a legal admission transition for an otherwise eligible authorised claim, including after a provider switch. This is enabledness, not unconditional eventual execution.

Run with a trusted TLA+ tools distribution:

```sh
java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers 1 -config OrdinaryContinuation.cfg OrdinaryContinuation.tla
```

For #1308, run the restored baseline and two separate temporary mutations (restore the model between runs):
- Add `/\\ p = origin` to `Admit(t, p)`: expect a `ValidAdmissionEnabled` violation after an authorised deliberate switch to a different provider.
- Remove only `/\\ Allowed(p)` from `Admit(t, p)`: expect a `NoUnauthorisedAdmission` violation for a removed or locked-out provider.

Record actual TLC checker identity, generated/distinct state counts, invariants and counterexamples on the qualifying PR head. The expanded model has not yet been checked by TLC. The **previous** provider-independent configuration passed TLC 2.19 (80 distinct, 121 generated, depth 7); a removed freshness guard violated `NoRetiredClaim`. These historical results do not qualify the expanded model.

The model assumes Workstream/root/native-session provenance and exact claim/lease authority are proven at their implementation boundaries. Reclaim presupposes no admitted successor; Stop is cancellation, not proof of process termination. It abstracts the durable selection evidence to a Boolean, not a generation counter or session history, and does not represent platform configuration files, OS processes, queue correlation, provider attempts after admission, continuous authorisation changes, or exactly-once external effects. The finite token set prevents further claims at exhaustion. See the transition map and owning executable tests.

## Bounded rollout-fence model

`RolloutFence.tla` models two roles, an all-role fence, one abstract writer per role, positive containment, offline operations, activation, healthy rollback and unsafe termination. TLC 2.19 explored 24 distinct states (43 generated, depth 11) with no violations of the four configured invariants. Removing the `writers = {}` precondition from `Offline` produced a five-state counterexample to `OfflineExclusive`; this checks that the invariant can detect that particular missing guard.

This is a design abstraction, not an implementation proof. Current main can arm an eligible recovery continuation within the admission transaction before setting the fence; this interaction is not modelled. It assumes fences block every new writer and containment reports truthfully. It does not yet model individual processes, foreign or respawning writers, partial fence-release failure, exact tokens, WAL/backup, readiness evidence, restart races, or the existing post-start rollback prohibition. The `healthy` and `rollbackHealthy` transitions represent externally proven outcomes, not evidence that such proof exists. Existing relevant tests include `test/idleUpgradeAdmission.test.ts` and `test/rolloutHelper.test.ts`; their relationship to each modeled transition still needs a detailed audit.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config RolloutFence.cfg RolloutFence.tla
```

## First implementation test map

These are concrete existing tests, not yet a complete transition matrix or a proof that they refine the model. On main `7793aed`, the three files `test/runContinuation.test.ts`, `test/acpOutwardCapacityRecovery.test.ts` and `test/idleUpgradeAdmission.test.ts` passed locally: 82 tests total.

| Model / implementation boundary | Existing evidence | Remaining distinction |
| --- | --- | --- |
| Pending → claimed | `runContinuation.test.ts`: claims only once when due | Due time, origin/session authority and SQLite atomicity are abstracted out of the TLA+ model. |
| Claimed → successor / stale claim | `runContinuation.test.ts`: fences ordinary outward successor linkage; reclaims lost claim before successor admission | The model assumes fresh tokens and collapses queue and transaction boundaries. UUID collision is probabilistic, not impossible. |
| Stop before successor | `acpOutwardCapacityRecovery.test.ts`: Stop cancels claimed ordinary wake | Stop after successor admission and actual process termination need a separate model. |
| Expiration / restart | `runContinuation.test.ts`: expires bounded continuation; preserves pending continuation across restart | Crash between queue, correlation, claim and provider submission is not fully represented. |
| All-role fence / writer race | `idleUpgradeAdmission.test.ts`: serializes idle check with older writers; does not mistake concurrent SQLite writer for idle | Model assumes fencing works and does not prove OS-level writer containment. |
| Ambiguous capacity receipt | `runContinuation.test.ts`: does not complete merely because its receipt disappeared | Capacity continuations are explicitly outside the ordinary model. |

## Pre-fence recovery (current main)

`RolloutRecovery.tla` abstracts one eligible outward Workstream: the atomic admission step arms a continuation and installs the role fence; a pre-stop abort can release the fence without an interruption audit; a later attempt may reuse the armed record; only an interrupted origin, completed proven audit, released fence and no prior Stop permit claim. TLC checked 34 distinct states (134 generated, depth 6) with no invariant violations. This version requires a current absent-process observation before claiming; removing that guard yields a counterexample with a live process. Removing the proven-audit guard produced a counterexample in which an ambiguous audit was claimed. Deadlock checking is disabled because terminal paths are intentionally represented without outgoing actions.

This does not model Stop after claim, claim leases, duplicate or malformed audits, process identity, user-turn or provider-session binding, multi-role partial rollback, or readiness and health before release. The process observation is abstract and frozen after claim; it does not prove the process cannot respawn. `Release` is an abstract environment transition and is **not** proof that the implementation established healthy activation or rollback. The model does not establish implementation conformance. Source anchors are `armInterruptedWorkstreamRecovery` and `tryAdmitIdleUpgrade` in `src/idleUpgradeAdmission.ts`, and `provenPostRolloutAudit` and `claimDueRunContinuation` in `src/runContinuation.ts`.

At main `07ca07770a99af91c4461fb3fed82687ea6cb5cb`, the local `runContinuation`, `acpOutwardCapacityRecovery`, `idleUpgradeAdmission` and `rolloutContinuation` suites passed: 98 tests across four files. These tests are evidence about their particular scenarios, not proof that every modeled transition or state is covered.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config RolloutRecovery.cfg RolloutRecovery.tla
```

## Event receipt abstraction

`EventReceipt.tla` models the Telegram/Slack repository operations for one retained idempotency key, including an allowed late Run link after completion. TLC explored 17 distinct states (34 generated, depth 5) and checked type, at-most-one dispatch claim and ambiguous-state terminality. Allowing an already-dispatching receipt to be claimed again produced an `OneDispatch` counterexample. This is **not** a proof of exactly-once external effects: the model abstracts the database uniqueness/CAS and does not cover retention expiry, process crash, external submissions, queue ownership, or autonomous receipt transitions. It only models repository methods, not every direct SQL writer.

On main `07ca077`, `test/telegramPollAdmission.test.ts`, `test/slackIngress.test.ts` and `test/slackSurfaceIntegration.test.ts` passed locally (50 tests). They include duplicate admission, one claimant, ambiguous failure and restart scenarios; an exhaustive transition-to-test audit remains. Historical worker tables in `legacyBaselineMigration.ts` are dropped by `dropLegacyWorkerTablesMigration.ts`; do not count their legacy statuses as active machines without tracing migration and runtime use.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config EventReceipt.cfg EventReceipt.tla
```

## Capacity-wait abstraction

`CapacityWait.tla` explores a retained-queue capacity wait with receipt loss, a correlated successor, Stop and a retry after a proven capacity rejection. TLC checked 18 distinct states (23 generated, depth 5) without violating its three invariants. Removing the completed-successor guard produced a counterexample that marked a missing receipt complete with no successor.

The model is deliberately narrower than production: it abstracts claim tokens and leases, attachment cleanup, notification delivery, expiration while claimed, exact provider/session identity and the outward ACP variant where a correlated `done` successor can prove completion without the retained queue condition. Stop is a state transition here and does not establish process termination. `retryProof` is an abstract input, not proof that the actual provider failure classifier is correct. Existing current-main tests in `test/runContinuation.test.ts` cover missing receipts, matching successors, capacity retries and expiry; `test/acpOutwardCapacityRecovery.test.ts` covers outward recovery and Stop. These were included in the 98-test run above. Implementation refinement and edge coverage remain open.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config CapacityWait.cfg CapacityWait.tla
```

## Queue admission and Stop

`QueueStop.tla` abstracts one queued item, two lane acquisitions, claim transfer and a Stop racing Run admission. TLC checked 39 distinct states (106 generated, depth 9) against five configured invariants. Removing the claim-owner guard produced a `NoStaleAdmission` counterexample after lane ownership changed. The abstraction treats queue discard and Stop-fence installation as atomic and records a cancellation request for an already-running Run; it does **not** prove the provider process stopped, external effects were undone, subsequent messages are rejected, or the real SQLite transitions refine the model. It omits lease timing, queue receipts, multiple messages, Stop-fence clearing and provider submission races.

On `07ca077`, the `executionLaneCorrectness`, `acpOutwardQueueDrain` and `executionLaneCoordinator` suites passed locally (61 tests). Source anchors are `BridgeDb.claimNextPendingMsg`, `BridgeDb.ownsPendingClaim`, `OutwardAcpPromptExecutor.cancel` and the fenced admission in `src/acpServer/execution.ts`. Mapping individual tests to every race and a production-shaped process termination test remain open.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config QueueStop.cfg QueueStop.tla
```

## Multi-role fence cleanup

`MultiRoleFence.tla` models two independently acquired role fences, denied admission, token-bound cleanup, cleanup failure producing `unknown`, and release after an abstract healthy state. TLC checked 20 distinct states (36 generated, depth 9) against four invariants. A mutation permitting an incorrect token to release a role yielded a `NoForeignRelease` counterexample, including when the only wrong token available belongs to the other role.

The model represents each role's exact token by that role's symbolic identity and explores using the other role's token; it abstracts token generation, PID/boot identity and UUID collision. The `contained` and `healthy` states are assumptions here, not verified OS containment or service-health evidence. It does not model concurrent writes, partial guard installation, owner PID reuse, pre-armed recovery, WAL or post-start rollback safety. The current-main `idleUpgradeAdmission.test.ts` cases for cohort deferral, missing roles, exact-token cleanup after mismatch and prior-owner containment were included in the 98-test run; those tests and the model do not prove refinement.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config MultiRoleFence.cfg MultiRoleFence.tla
```

A focused SQLite regression in `test/idleUpgradeAdmission.test.ts` now swaps two valid role tokens, checks that neither fence is released, then releases both using their original tokens. The full idle-admission file passed locally (20 tests). This is implementation evidence for that specific token-substitution scenario, not a proof of the whole rollout.

## Autonomous goal cycle abstraction

`AutonomousGoal.tla` models a bounded two-cycle goal, a single wake, a claimed Run, continue or fresh-cycle recovery, terminal dispositions and cancellation. TLC checked 13 distinct states (13 generated, depth 5) against type, budget and cancellation invariants. A mutation that removed both the budget check at claim and budget termination generated a counterexample exceeding the cycle budget; it does not establish that either check is individually sufficient.

This is a deliberately small abstraction of `src/autonomousGoalRuntime.ts`, not a refinement or liveness proof. It combines successful continue, provider failure and restart recovery into one action; it omits durable receipt identity, supervisor inputs, process containment, evidence, notification, leases and concurrency. The model records cancellation but does not prove an in-flight process stops or that late results are fenced. Related tests are in `test/autonomousGoalRuntime.test.ts`, `test/autonomousGoalCancellationFence.test.ts` and `test/autonomyDispositionContract.test.ts`; those three suites passed locally on `07ca077` (46 tests); an exhaustive transition mapping is pending.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config AutonomousGoal.cfg AutonomousGoal.tla
```

## Run terminal writes: a scoped invariant

`RunTerminal.tla` models only `RunRepository`'s compare-and-swap terminal methods: running → done, failed or cancelled, first writer wins. TLC checked four states and three invariants. Removing the running-state guard produces a second terminal write counterexample. A new parameterized SQLite test in `test/db.test.ts` exercises each first terminal result followed by all three late repository writers; `db`, `eventStore` and `acpOutwardCancellationRace` suites passed locally (32 tests).

**Do not generalize this repository-method invariant to every writer.** `src/autonomousGoalRuntime.ts` has explicit reconciliation paths that can change a `done` Run to `failed` when a durable objective disposition is missing or a wake is orphaned. Those paths need separate modeling and safety review; this model does not cover them, concurrent database connections, event atomicity, provider processes, or the distinction between exchange completion and objective completion.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config RunTerminal.cfg RunTerminal.tla
```

## Autonomous Run reconciliation exception

`AutonomyReconcile.tla` represents a narrow missing-disposition path in `src/autonomousGoalRuntime.ts`: an already `done` provider Run may be reclassified `failed`, while an already `cancelled` Run remains cancelled. TLC explored five distinct states and checked four invariants. Allowing the missing-disposition action to overwrite a cancelled Run produces a `CancelledRunNotOverwritten` counterexample. This model omits budgets, Stop after provider completion, orphan recovery, database interleavings, actual process termination and all successful dispositions; it is not a refinement proof.

A new test in `test/autonomyDispositionContract.test.ts` explicitly marks the provider Run done before returning without a disposition, then checks the failed Run, failed receipt and fresh recovery cycle. That suite plus `autonomousGoalCancellationFence.test.ts` passed locally (10 tests). This demonstrates the intended exception at this boundary, not that all late-result races are covered.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config AutonomyReconcile.cfg AutonomyReconcile.tla
```

## Updated process-observation evidence

At `e435ce689e7fbe577026f9bd28adedf565edd427`, the local `rolloutContinuation` and `rolloutLifecycle` suites passed 28 tests, including the new parameterized case that makes the production scanner reject both `live` and `ambiguous` process observations. This mocks the process observation; it does not prove the OS scan is exhaustive or that a process cannot reappear after observation. `RolloutRecovery.tla` likewise freezes its abstract observation after claim; the observed result is not a no-respawn proof.

The guarded recovery tests on the earlier `07ca077` baseline include pre-fence arming, an existing pending wake, ambiguous accepted turns, Stop/Reset and duplicate wake scans. They should be rerun at the current head before relying on exact-head results; the two current-head suites above include the rollout-continuation cases, while the earlier combined 98-test result is not an exact-head result.

## Late provider result after Stop

`LateProviderResult.tla` abstracts the ordering of a Stop request, a provider's return and final response settlement for one outward Run. TLC checked six distinct states (seven generated, depth four) with no invariant violations; forcing publication despite cancellation produced a counterexample. A new regression in `test/acpOutwardCancellationRace.test.ts` uses a gated mock provider that returns success after Stop: the persisted Run is cancelled and the late final answer is neither appended to history nor emitted in the captured updates. That file passed three tests on `e435ce6`.

This does not prove that a real provider process terminates, that earlier streamed content can be retracted, that side effects are undone, or that the asynchronous source implementation refines the atomic settlement action. Stop after settlement, remote owners, session persistence and transport failure are not represented.

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 1 -config LateProviderResult.cfg LateProviderResult.tla
```

## Current-head real-process evidence and containment boundary

On `e435ce6`, the `full process tree` cases in `test/cliSupervisorMatrix.test.ts` passed (three tests): abort and shutdown wait for TERM-resistant descendants; a Run-owned detached tool is ended while an unmarked bystander remains alive. The `interruptible release with SQLite writer containment` cases in `test/rolloutHelper.test.ts` passed (three tests): an external live writer is terminated and reconciled, a respawning writer prevents offline work, and the release caller chain is excluded from termination. These are bounded real-process fixtures, not a production deployment or exhaustive OS proof.

The caller-chain test holds an open SQLite connection and performs a read; it does **not** prove that every possible caller-chain process with a writable database handle is quiescent. The containment script deliberately excludes ancestors of its process. Whether active or future writes by such an ancestor can cross the offline boundary, and whether the full writer-fence contract covers that case, require a production-shaped investigation before treating the model's no-writers assumption as established. Do not infer a confirmed production defect solely from the fixture.

A disposable caller-chain fixture demonstrated that an ancestor worker thread with an already-open connection could insert a non-fenced `settings` key after the checkpoint command was invoked while the rollout succeeded. This establishes a gap in the old containment assumption for that fixture; it does not demonstrate that the independent production systemd handoff has such an ancestor. The candidate containment change now refuses an observed caller-chain database handle before offline work, without signaling that caller. An FD scan is a point-in-time observation: it cannot exclude a caller opening a database later, nor does it establish that all release descendants are quiescent. The general no-writers assumption and production handoff correspondence remain open.

## Output retention and qualification: implementation test correspondence

On `e435ce6`, `fileOutput.test.ts` exercises mixed delivery with retained failures, retry of retained files, expiry cleanup, publication fencing, and unsupported attachments. `fileOutputRetentionInvariant.test.ts` covers preserving the original expiry on a repeated failure, malformed marker handling during restart-style cleanup, and an inaccessible sibling. The corresponding three-suite local run including `acpQualificationBoundaries.test.ts` passed 24 tests. These are scenario tests, not an exhaustive transition matrix: process death between individual uploads and marker persistence and all marker and filesystem failure combinations remain to be assessed. A gated in-flight upload test now verifies that cancellation after publication begins prevents a subsequent upload and records the already completed one; it cannot retract a delivery already in progress. The two output suites pass 20 tests on `e435ce6` with this addition.

`acpQualificationBoundaries.test.ts` tests the managed-release mismatch and structured error classification/redaction; it does not by itself establish coverage for all qualification statuses, candidate identity transitions, or persisted-evidence races. The qualification and retention inventories above remain unmodeled.

`OutputDelivery.tla` abstracts two successful uploads and a Stop racing an already started upload. TLC checked 21 distinct states, 27 generated, depth 7, with type, disjointness and complete-all invariants; deadlock checking is disabled for intentional terminal states. The `Start` guard encodes the assumption that no new upload starts after Stop. This model allows an in-flight upload to finish and cannot retract it. It omits upload failure, retention, durable markers, crashes, retries, transport behavior and a refinement proof; the gated `fileOutput.test.ts` case exercises the analogous race in the implementation.

| Output event | Implementation evidence | Current modeled/test boundary |
| --- | --- | --- |
| Start another upload | `uploadOutputFiles` checks `canPublish` before each `sendPhoto` or `sendDocument` | `OutputDelivery.Start` assumes the check; gated in-flight test observes no second call after the fence. It does not make the check and external send atomic. |
| Stop while upload is pending | `uploadOutputFiles` awaits the send and checks `canPublish` again before the next send and before settlement | `OutputDelivery.Stop` and `Finish` permit an already issued send to complete. The gated test checks cancellation and the completed upload count, not transport-side delivery guarantees. |
| Upload failure | Failed file enters `failedPaths`; partial result may be retained behind an expiry marker | Existing output tests cover a single mixed failure and retry. This is outside `OutputDelivery.tla`; crash between send, unlink and marker persistence is unmodeled. |
| Retention cleanup | Existing valid expiry is preserved; malformed or inaccessible metadata fails closed | Retention-invariant tests cover expiry preservation and malformed markers; timer and restart interleavings are unmodeled. |

The `NoStartAfterStop` action property additionally checks that pending files cannot decrease after Stop in this abstraction. TLC passes it for the guarded model; removing `allowed` from `Start` produces a counterexample. This mutation checks the property, not atomicity or refinement of the implementation's separate publication check and send.

Slack readiness is an observation, not a socket routing guarantee: `SlackStatusWriter` can publish connecting, connected, reconnecting, disconnected, reconnect-required or failed, and a connected observation can still carry a degradation error. `isSlackStatusCurrent` additionally checks schema, PID, optional generation/app/team and timestamp freshness; a future or invalid timestamp is rejected. `test/slackConfigStatus.test.ts` covers transition recording, degradation/recovery, write failure and identity/freshness, including future timestamps and mismatched team (9 tests pass on `e435ce6` with additions). Timer interleavings, generation replacement across processes, event ordering and actual connection identity are not modeled or exhaustively verified.

`SlackReadiness.tla` is a finite observation model with two symbolic generations, socket-state changes, optional flush (including omitted/failed flush), restart and age progression. TLC explored 1,752 distinct states, 25,682 generated, depth 7, checking type and the definition of current observation. These health invariants follow directly from the modeled `Current` predicate; they do not prove the real consumer passes generation/identity or that the published observation reflects the live socket. The model allows generations to be reused, abstracts app/team/PID and actual clock/atomic I/O, and does not establish freshness of UUIDs, safe ordering of concurrent writers or event delivery. Existing status tests cover parts of the predicate; no refinement proof is claimed.

## Continuation test correspondence

On `e435ce6`, `runContinuation.test.ts` and `rolloutContinuation.test.ts` pass 75 tests. Within those suites, pending-to-claimed ownership and stale-claim fencing are exercised by the lost-claim and stale-callback cases; dispatch-to-terminal outcomes by the queued success, failure and Stop cases; expiry by lifetime and expiry-delivery cases; capacity recovery by lost receipt, completed successor and crashed claimant cases; and rollout recovery by pre-fence arm, exact-fence release and audit scenarios. These are concrete examples, not a proof of every cross-product or a formal refinement: the abstractions still omit interactions including full provider/process identity, arbitrary crash points and effects outside the database.

## Scheduled occurrence correlation

`src/scheduledRunCorrelation.ts` stores claimed, running, completed, failed and fenced occurrence evidence linked to a Run. A different Run may replace a linked one only when the previous Run is missing, failed or cancelled; a done Run cannot be marked failed through `markScheduledOccurrenceFailed`. The engine and hardening suites exercise pre-provider linking, terminal correlation, capacity-failure rebinding, admission failure, unrelated-run exclusion and persistence across routine deletion/reopen: 10 tests pass on `e435ce6`. Missing Run is explicitly replaceable and is not proof of no external effect. This state machine and its claim/dispatch concurrency, crash and retry semantics are not yet modeled or fully mapped.

`ScheduledCorrelation.tla` models repository correlation for two Runs, including running-to-terminal transitions and replaceable missing/failed/cancelled links and protection of a done link from replacement or failure marking. TLC checked 170 distinct states, 717 generated and depth 4. Removing the replacement guard produces a counterexample. This is a narrow atomic repository abstraction: terminal statuses are fixed, and it excludes Run admission, transactions in flight, external effects, dispatch, crashes, retry safety and refinement. In particular, replaceable `missing` is not proof that a Run never produced an effect.

Removing the model's separate failure-mark guard also violates `NoReplaceDone`. The existing scheduled-correlation rebinding regression now additionally checks the implementation rejects late failure marking after linking a completed Run; the targeted case passes. Neither result establishes behavior under concurrent direct database writers.
