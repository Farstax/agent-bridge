# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Proceed with **Option 2: make the existing Agent Bridge autonomous-goal runtime a first-class capability of the existing interactive service**.

Do not build a Company runtime in OSS. Do not build a second orchestration framework. Do not migrate legacy Company execution data.

The intended topology is:

```text
Farstax Company pack (Markdown + Soul + Skills)
                    |
                    v
Telegram owner -> existing Agent Bridge interactive process
                    |
                    +-> /autonomy status|approve|stop
                    |
                    v
          separate fresh Bridge SQLite DB
                    |
                    v
          existing autonomous_goals runtime
                    |
                    v
             ordinary Bridge Run
                    |
                    v
           Claude / Codex / Agy
```

There is one Telegram poller, one Agent Bridge runtime identity, one provider execution path, one cancellation path, and one autonomous lifecycle owner.

The current Platform Company control socket, `runuser/env -i` process boundary, shelling into `scripts/autonomous-goal-operator.ts`, and duplicated episode lifecycle become temporary compatibility machinery to delete after qualification.

## What this plan deliberately does not preserve

The current Company execution state is not a production state worth migrating.

The new path starts with a **fresh, current-schema Agent Bridge database** dedicated to autonomous execution. The old Company database and Platform Company episode rows are not copied, transformed, linked, reconciled, dual-written, or assigned replacement IDs.

Authoritative business facts such as beta funnel/customer state remain in Platform because they are business-system facts, not autonomous-runtime state.

Rollback before final subtraction is configuration rollback: disable the new path and re-enable the old path. It does not require a reverse data migration because no data was transferred.

## Company definition: files, not runtime schema

Farstax owns a versioned Company pack. A representative layout is:

```text
company/
  AUTONOMY.md
  mission.md
  goals.md
  operating-model.md
  constraints.md
  SOUL.md
  skills/
    farstax-platform-operations/SKILL.md
    farstax-editorial-gate/SKILL.md
    farstax-voice/SKILL.md
```

Only two names need generic runtime meaning in the first implementation:

- `AUTONOMY.md`: the owner-authorized episode entry instruction/prompt.
- `SOUL.md`: optional Soul loaded with the existing Soul loader.

The other Markdown files are ordinary workspace content. Agent Bridge does not parse `mission.md`, `goals.md`, `constraints.md`, or any Farstax-specific structure. Providers can read them normally because execution cwd is the Company pack root. Skills continue to use the existing Skills installation/projection mechanism; autonomy does not introduce a Skills loader.

This keeps the OSS boundary generic:

> Agent Bridge executes an owner-authorized autonomous episode in a configured workspace. It does not know that the workspace represents a company, mission, funnel, growth plan, or business.

SQLite contains only execution state that needs durability/concurrency semantics: goals, wakes, ordinary Runs, cancellation, cycle budget, and bounded evidence.

## Existing primitives to reuse unchanged

`src/autonomousGoalRuntime.ts` already owns the hard parts:

- `createAutonomousGoal()` atomically creates a durable goal and initial wake;
- `runNextAutonomousGoal()` claims a wake, creates an ordinary `bridge_runs` row, acquires the existing `autonomous:<goalId>` execution lane and invokes `BridgeEngine.executeSurfaceNeutralTurn()`;
- `drainAutonomousGoal()` executes bounded successor wakes without introducing a second executor;
- claimed-but-unreconciled wakes are not blindly replayed after restart;
- cycle budgets are rechecked at the actual Run-claim boundary;
- bounded evidence is persisted on the existing goal;
- cancellation uses the ordinary Run/descendant ownership machinery;
- cycle reconciliation already exposes a bounded `CycleReconciledEvent` observer seam.

`src/cliSupervisor.ts` and `src/cli.ts` already accept explicit child-process cwd and bounded `contextEnv`. Provider execution therefore does not need a new provider abstraction or a process-global environment virtualization layer.

`src/index-interactive.ts` already owns the single authenticated Telegram poller and ordinary owner delivery.

The standalone operator remains a useful diagnostic/manual CLI, but production Company execution must stop depending on Platform spawning it.

## Three options considered

### Option 1 — refine the current Platform orchestration

Topology:

```text
Telegram -> Agent Bridge -> Platform Company socket -> runuser/env -i
        -> standalone OSS operator -> BridgeEngine -> provider
```

Platform would continue to own episode start/stop/status and translate those operations into standalone operator invocations.

Advantages:

- smallest immediate behavioral change;
- existing process-level env/cwd isolation remains obvious.

Costs:

- two lifecycle owners remain;
- Platform still understands OSS execution details;
- a Company-specific Unix socket remains;
- process spawning and JSONL translation remain;
- cancellation/restart/status have two representations;
- deployment must keep a privileged/process-boundary contract in sync with OSS.

Decision: **reject**. It fixes symptoms while retaining the architecture #466 exists to remove.

### Option 2 — first-class autonomy in the existing Agent Bridge interactive process

Topology:

```text
Telegram -> Agent Bridge interactive process
              |-> normal interactive Runs
              `-> generic autonomous episode -> ordinary Run -> provider
```

The interactive process opens a second, dedicated Bridge DB for autonomy and constructs an autonomous `BridgeEngine` with explicit workspace/Soul context. The existing autonomous-goal runtime owns lifecycle and durable execution.

Advantages:

- one poller and one process identity;
- no Platform execution socket;
- no `runuser/env -i` bridge;
- no standalone operator dependency in production;
- existing ordinary Run/cancellation/provider paths remain authoritative;
- Company definition remains files/Skills outside OSS semantics.

Main risk:

- `BridgeEngine` currently resolves execution cwd/workspace context through process-global defaults in several paths. It must accept explicit execution context consistently without mutating `process.cwd()` or `process.env`.

Decision: **recommend**, subject to Slice 1 below. If Slice 1 cannot be implemented as a small explicit-context change, stop and use Option 3 rather than broadening the abstraction.

### Option 3 — dedicated generic OSS autonomous service

Topology:

```text
Telegram -> Agent Bridge interactive process -> local generic autonomy control
                                           -> Agent Bridge autonomous service
                                           -> ordinary Run -> provider
```

This keeps generic autonomous lifecycle in OSS but uses a second non-Telegram Agent Bridge process for natural cwd/env isolation. The interactive process remains the only Telegram poller.

Advantages:

- clean process isolation;
- Platform still loses Company execution ownership.

Costs:

- another service/process remains;
- another local control boundary is needed;
- more restart/deployment/service configuration than Option 2.

Decision: **fallback only** if explicit in-process execution context proves invasive.

## Smallest generic runtime contract

The first implementation supports **one configured autonomous workspace per interactive service instance**. Do not build a profile registry or multi-tenant autonomous organization model before a second real use case exists.

Initial configuration should be limited to:

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/company
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
```

Optional cycle-budget configuration may be added only if qualification proves the existing bounded default is operationally insufficient. Do not add autonomy-specific provider command, credential, Soul-path, context-path, Skills-path, HOME, PATH, or arbitrary env-overlay settings.

Conventions:

- execution cwd = `AGENT_BRIDGE_AUTONOMY_DIR`;
- entry prompt = `<dir>/AUTONOMY.md`;
- Soul = `<dir>/SOUL.md` when present, loaded through existing Soul code;
- provider configuration/credentials = the normal Agent Bridge service configuration and runtime user;
- Skills = existing CLI Skills projection, installed by the owning deployment/configuration layer;
- DB = separate normal Bridge DB at `AGENT_BRIDGE_AUTONOMY_DB_PATH`.

Configuration is disabled when the two required paths are absent. Partial configuration fails closed at startup with a bounded configuration error.

## Owner lifecycle: existing goal is the authorization

Do not add an `autonomy_series`, `episode`, `owner_gate`, or Company table.

One `/autonomy approve` means: **the authenticated owner authorizes exactly one new bounded autonomous goal**.

The goal row created by `createAutonomousGoal()` is itself the durable authorization record. Its initial wake is created in the same transaction. There is no separately persisted `awaiting_owner` state.

Derived state:

- active goal exists -> `running`;
- no active goal and a latest terminal goal exists -> `awaiting owner` plus latest result;
- no goal exists -> `not started / awaiting owner`;
- terminal statuses are the existing `complete`, `blocked`, `cancelled`, and `budget_exhausted` values.

A terminal goal never creates the next owner episode. The only code path that creates another top-level goal is another authenticated `/autonomy approve`.

### Goal identity

Each approval generates a fresh opaque goal ID, for example `autonomy:<uuid>`. It does not encode Farstax, Company, funnel, mission, or legacy episode identity.

### Only three commands initially

```text
/autonomy status
/autonomy approve
/autonomy stop
```

Do not add `pause` in the first implementation. Pause requires resumability semantics that are not needed to prove the Farstax workflow and are not equivalent to existing cancellation.

`approve` must return immediately after durable authorization is committed and background execution has been scheduled in-process. It must not hold the Telegram interactive lane while the autonomous episode drains.

`status` and `stop` therefore remain usable during a running episode.

`stop` resolves the active goal and delegates to the existing autonomous cancellation function. It must not invent a second kill/fence path.

## Runtime module shape

Add one small generic module, tentatively `src/autonomyControl.ts`. It is an adapter over existing primitives, not another engine.

Responsibilities:

1. Validate the two configured paths and refuse to use the interactive DB path.
2. Read `AUTONOMY.md` and optional `SOUL.md` with bounded file-size validation.
3. Open the already provisioned autonomy DB using the normal production DB open path.
4. Construct/reuse an autonomous `BridgeEngine` using normal bot/provider configuration plus explicit cwd/workspace context.
5. Expose `status()`, `approve()`, and `stop()` operations.
6. On startup, perform one bounded recovery pass for existing active autonomous goals in this dedicated DB.
7. Run a newly authorized goal asynchronously using `drainAutonomousGoal()` and catch/report terminal execution failures.
8. Surface existing bounded `CycleReconciledEvent` progress to a caller callback. The surface entrypoint owns actual Telegram/Discord delivery.
9. Close the second DB during service shutdown.

It must not:

- poll on a timer;
- own a worker loop;
- parse Company files other than the generic entry/Soul conventions;
- manage provider credentials;
- create a notification socket;
- create a second command framework;
- mutate process-global cwd/env;
- add a generic scheduler;
- persist a second lifecycle model.

## Slice 1 — explicit BridgeEngine execution context

**Purpose:** prove Option 2 is safe before adding owner UX.

Expected production files:

- `src/engine.ts`
- `src/workspaceContext.ts` only if its current public helper cannot accept preloaded explicit context cleanly.

Add the minimum explicit options to `BridgeEngineOptions`:

```ts
executionCwd?: string;
workspaceContext?: string | null;
```

Semantics:

- when absent, preserve existing behavior exactly;
- when `executionCwd` is present, every provider invocation made by that engine uses it instead of calling the process-global cwd resolver;
- retry/model fallback/continuation paths touched by the engine must retain the same explicit cwd;
- when `workspaceContext` is explicitly supplied, prompt construction uses that value; it must not re-read a process-global workspace-context setting;
- Soul remains the existing explicit `soulContext` option;
- child-process env scrubbing remains owned by the existing CLI supervisor; do not add a generic full env overlay.

Expected red tests before implementation:

- `test/engine.test.ts`: two engines in the same process use different explicit cwd values and each CLI invocation receives the correct one;
- `test/engine.test.ts`: fallback/retry execution cannot fall back to process-global cwd;
- `test/runtimeIsolation.test.ts`: executing the two contexts leaves `process.cwd()` unchanged and does not mutate relevant `process.env` values;
- `test/workspaceContext.test.ts` only if helper behavior changes: explicit context beats process-global/default context and remains isolated between engines.

Existing provider/unit tests must remain green without setting the new options, proving backward compatibility.

### Slice 1 kill-switch

Stop Option 2 if satisfying those tests requires any of:

- `process.chdir()` swapping;
- temporary mutation of `process.env` around a Run;
- a virtualized environment object threaded through the whole provider stack;
- a new provider-launch abstraction beside `runCli`/`runSupervisedProcess`;
- provider-specific autonomous execution code.

If that happens, implement Option 3 instead. Do not make Option 2 work by creating a larger framework.

## Slice 2 — generic autonomy controller over the existing goal runtime

Expected production files:

- new `src/autonomyControl.ts`;
- `src/autonomousGoalRuntime.ts` only for a narrow exported query/helper if the controller cannot use an existing public function;
- no DB migration is planned.

Expected test file:

- new `test/autonomyControl.test.ts`;
- focused additions to `test/autonomousGoalRuntime.test.ts` or `test/autonomousGoalCancellationFence.test.ts` only when an existing invariant needs coverage at the lower level.

### `approve()` behavior

1. Verify configuration and pack files.
2. Query the dedicated autonomy DB for an existing `active` goal.
3. If one exists, return that goal as already running; do not create another.
4. Generate an opaque new goal ID.
5. Read bounded `AUTONOMY.md` as the goal prompt.
6. Call existing `createAutonomousGoal()` with generic authority constraints, selected normal provider kind, and bounded max cycles.
7. Because `createAutonomousGoal()` creates the goal and wake transactionally, authorization is durable before the command reports success.
8. Schedule `drainAutonomousGoal()` on an in-process detached promise with an explicit `.catch()`; do not await the drain from the owner command.
9. Return goal ID/status immediately.

The implementation must make the check-and-create operation race-safe under the actual single interactive process. Prefer one DB transaction around the invariant rather than a new table/index. Add schema only if a failing concurrency test proves the existing transaction/ownership model cannot enforce one active episode.

### `status()` behavior

Return a bounded generic view only:

```ts
{
  state: "awaiting_owner" | "running";
  goalId: string | null;
  goalStatus: AutonomousGoalStatus | null;
  cycle: number;
  maxCycles: number;
  evidence: string[];
}
```

`awaiting_owner` is presentation state derived from the absence of an active goal. It is not stored in SQLite.

When no active goal exists, use the newest goal by `created_at` to show the latest terminal evidence. No history API is required.

### `stop()` behavior

1. Resolve the active goal.
2. If none exists, return the derived awaiting-owner state idempotently.
3. Delegate to existing `cancelAutonomousGoal()`.
4. Return the resulting existing goal status.

No separate process-kill mechanism is allowed.

### Startup recovery

At service startup, after opening the dedicated autonomy DB and before announcing the control surface ready:

- query active goals in that DB;
- for the expected single configured autonomy workspace, recover at most the active goal;
- invoke the existing drain/run-next semantics once in a detached, caught task;
- an unclaimed durable wake may continue;
- a previously claimed wake must follow existing `recoverUnreconciledWake()` behavior and must never blindly cross the provider boundary again;
- terminal goals are never restarted;
- no timer is created after startup.

Tests must cover process restart between durable goal creation and provider claim, and restart after wake claim before reconciliation.

## Slice 3 — wire the existing authenticated owner surface

The generic controller is surface-neutral. The first production integration is the existing Telegram interactive service because that is the required Farstax path.

Expected production files:

- `src/index-interactive.ts`;
- `src/interactiveBot.ts` only for Telegram command registration/help metadata if required.

Use the existing `BridgeEngineHooks.onCommand`/interactive routing seam rather than adding a new command dispatcher.

Owner authorization remains the existing Telegram allowed-user check. The autonomy controller must never accept an owner ID supplied by the Company pack or by provider output.

Command results:

- `/autonomy status` -> compact current/last state and bounded evidence;
- `/autonomy approve` -> confirms durable goal ID and that execution started asynchronously;
- `/autonomy stop` -> confirms cancellation/terminal status.

### Async progress and terminal delivery

The controller accepts lifecycle callbacks. `index-interactive.ts` adapts those callbacks directly to the existing `TelegramClient`/`sendTelegramMessage` path.

Do **not** route same-process autonomy notifications through `ownerNotificationIngress`. That Unix socket exists for other local processes; using it for an in-process producer would add a boundary without value.

Cycle notifications must use the already bounded `CycleReconciledEvent` fields only. Do not expose raw provider stdout, hidden reasoning, tool logs, or transcripts.

Notification failure must not roll back or change reconciled autonomous state. The next `/autonomy status` remains authoritative even if a progress message was not delivered.

No persistent notification queue/cursor is planned for the first implementation. Add one only if a concrete acceptance test establishes a required delivery guarantee that the existing owner surface cannot provide.

Expected tests:

- `test/interactiveBot.test.ts`: command registration does not create a second poller or provider path;
- focused command-routing test: unauthorized updates cannot invoke autonomy;
- focused command-routing test: `approve` returns without awaiting the episode drain;
- focused command-routing test: `status` and `stop` are accepted while the episode task is running;
- `test/messageDelivery.test.ts` only if existing delivery behavior is changed; otherwise leave it untouched.

Discord wiring is not required for the first Farstax cutover. The controller must stay surface-neutral so Discord can add the same three commands later without runtime changes.

## Slice 4 — installation and runtime qualification

The OSS feature is not accepted merely because unit tests pass.

The install/deploy layer must provision:

- the Company pack root owned/readable by the normal non-root Agent Bridge runtime user;
- a **fresh** current-schema autonomy Bridge DB separate from the interactive DB;
- the two autonomy configuration paths;
- existing Company Skills through the existing skill installation/projection contract.

Do not create the DB opportunistically from `/autonomy approve`; production DB/schema ownership remains with normal install/upgrade tooling.

Qualification on the real runtime must prove all of the following:

1. Only the existing interactive Telegram process polls the bot token.
2. `/autonomy approve` returns promptly and one autonomous Run begins.
3. Provider process identity is the normal non-root Agent Bridge runtime user.
4. Provider cwd is exactly the Company pack root.
5. The provider receives the Company Soul and existing projected Skills.
6. The autonomy DB path is distinct from the interactive conversation DB.
7. An ordinary interactive message can still run while the autonomous episode exists, subject only to existing shared worktree/lane locking rules.
8. `/autonomy status` works during the autonomous Run.
9. `/autonomy stop` uses existing cancellation and fences provider descendants.
10. Restart after authorization but before wake claim resumes the durable episode exactly once.
11. Restart after wake claim does not replay a possibly-started provider call; existing blocked/recovery semantics are observed.
12. A terminal episode does not create a successor goal.
13. A second owner `/autonomy approve` creates the next fresh goal.
14. Progress/terminal evidence reaches Telegram asynchronously using bounded reconciled fields.
15. No legacy Company execution row was read or imported to make the new episode work.

Provider qualification should cover Claude, Codex, and Agy only to the extent the normal Agent Bridge provider path already promises them; autonomy must not add provider-specific qualification machinery.

## Slice 5 — Platform clean cutover

This is a separate Platform PR after the OSS runtime is released/qualified enough to consume.

Platform responsibilities during cutover:

1. Install/version the Farstax Company Markdown/Soul/Skills pack.
2. Provision the fresh autonomy DB using the current Agent Bridge schema/install path.
3. Configure `AGENT_BRIDGE_AUTONOMY_DIR` and `AGENT_BRIDGE_AUTONOMY_DB_PATH` on the existing interactive Agent Bridge service.
4. Keep authoritative beta/funnel/customer/business facts in their existing stores.
5. Disable the old Platform Company execution control path for the qualification window.
6. Run one real owner-authorized episode from Telegram and execute the qualification matrix above.

Explicitly do **not**:

- copy the old Company DB;
- import old `autonomous_goals`;
- preserve old episode IDs;
- dual-write Platform and OSS lifecycle state;
- translate old `company_events` into new runtime rows;
- reset or migrate beta/funnel business facts.

The old execution data may remain untouched temporarily for rollback/audit, but the new runtime must not depend on it.

## Slice 6 — Platform subtraction after qualification

Once the new path passes production qualification, remove the duplicated Platform execution machinery in a separate subtraction PR.

Concrete known deletions include:

- `src/control-plane/companyControl.ts`;
- `src/control-plane/companyOperatorProcessBoundary.ts`;
- `/run/agent-bridge-platform-company.sock` ownership/configuration;
- Company control server startup/shutdown glue in `src/control-plane/index.ts`;
- shell construction around `scripts/autonomous-goal-operator.ts`;
- `runuser --user ... /usr/bin/env -i` Company execution wrapping;
- Company-specific standalone runtime env-file/runtime-user/home configuration;
- Platform parsing/polling of `autonomous_cycle_reconciled` and `goal_result` JSONL;
- duplicated Platform episode execution lifecycle state where it exists only to mirror OSS running/terminal state;
- dedicated process-boundary/control tests and documentation whose contract no longer exists.

The standalone OSS `scripts/autonomous-goal-operator.ts` can remain as a manual/diagnostic tool. Production Farstax execution simply stops spawning it.

Platform keeps:

- SaaS/customer/workspace/provisioning/security/public service state;
- authoritative business/funnel/customer facts;
- Farstax Company Markdown content;
- Company Soul and Skills;
- any domain code required to produce/read those authoritative business facts.

## Failure, restart, cancellation, and concurrency semantics

### Authorization crash window

`createAutonomousGoal()` already creates the goal and initial wake in one DB transaction. If the process dies after commit but before the detached drain begins, startup recovery sees the active goal/wake and continues it.

### Provider ambiguity crash window

If the wake was already claimed into an ordinary Run, the existing autonomous runtime deliberately does not replay the provider after restart. It reconciles the orphaned wake and blocks/cancels the goal. Preserve that fail-closed behavior.

### Cancellation

`/autonomy stop` delegates to existing autonomous cancellation/ordinary Run descendant fencing. A cancelled goal cannot schedule a new top-level episode. A later episode requires a new owner authorization.

### Concurrent approvals

Exactly one active episode is allowed for the initial single configured workspace. The check-and-create operation must be atomic in the dedicated DB. This is a concurrency invariant, but it does not justify a new lifecycle table.

### Ordinary interactive concurrency

Autonomous Runs continue to use `surface=autonomous` and `chatKey=autonomous:<goalId>`. Existing execution-lane/worktree locking remains the final concurrency authority. Do not create an autonomy scheduler beside it.

## Test-first commit sequence for implementation PRs

Per repository rules, every behavioral slice starts with a failing regression committed before implementation.

### PR A — explicit execution context

Commit A1 (red):
- add explicit-cwd/workspace-context isolation tests.

Commit A2 (green):
- add the two narrow `BridgeEngineOptions` fields and route existing execution paths through them.

Stop here and independently review the exact head. If the implementation spreads into provider-specific/global-env machinery, reject Option 2 and switch to Option 3.

### PR B — autonomy controller

Commit B1 (red):
- approve creates one durable episode;
- duplicate concurrent approval cannot create two active episodes;
- status derives awaiting-owner/running state;
- stop delegates to existing cancellation;
- startup recovers unclaimed wake but never blindly replays claimed wake.

Commit B2 (green):
- add `src/autonomyControl.ts` as the thin adapter over existing DB/goal/engine primitives.

No migration commit is expected.

### PR C — Telegram owner surface

Commit C1 (red):
- authenticated command behavior;
- immediate approve response;
- status/stop usable while episode task runs;
- bounded async cycle/terminal notification.

Commit C2 (green):
- wire the controller into `index-interactive.ts` through existing command and delivery seams.

### PR D — Platform cutover

- install pack/fresh DB/config;
- no legacy-data import;
- production qualification evidence.

### PR E — Platform subtraction

- delete obsolete Company execution boundary and its tests/config/docs.

Do not combine PR D and E unless the old path can be removed without weakening rollback/qualification evidence.

## Expected subtraction

Known Platform production deletion starts with roughly 26 KB from `companyControl.ts` and `companyOperatorProcessBoundary.ts` alone, before startup glue/config/JSONL translation/lifecycle code is counted. Dedicated tests for those two boundaries add roughly another 21 KB of removable test surface.

OSS additions should be materially smaller and concentrated in:

- two optional explicit-context fields/uses in `BridgeEngine`;
- one thin `autonomyControl.ts` module;
- small Telegram wiring;
- focused tests.

Runtime concepts removed from the production Farstax path:

- one Company Unix socket;
- one cross-process control protocol;
- transient `tsx` autonomous operator launches;
- `runuser/env -i` Company execution boundary;
- duplicated Platform execution lifecycle;
- legacy execution-state migration/compatibility concerns.

Runtime concepts not added:

- Company model in OSS;
- organization framework;
- scheduler;
- worker;
- second poller;
- profile registry;
- episode-series table;
- owner-gate table;
- notification bus;
- generic provider-env virtualization.

## Acceptance for #466

The architecture spike is complete when this plan has been independently reviewed against the exact PR head and the implementation direction remains:

- Agent Bridge generic, Farstax semantics external;
- Company definition = Markdown/Soul/Skills/workspace content;
- SQLite = fresh runtime execution state only;
- no legacy execution-data migration;
- existing autonomous goals/Runs/provider/cancellation/delivery reused;
- one interactive owner surface and no second Telegram poller;
- no new scheduler/orchestrator/subagent framework;
- explicit in-process cwd/context isolation proven before owner UX is built;
- dedicated generic OSS service selected instead if that proof becomes invasive;
- Platform Company execution machinery deleted after clean-cutover qualification.

The implementation objective is subtraction: make autonomous execution a normal Agent Bridge capability, then remove the special Platform machinery that was only compensating for its absence.