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

The current Platform Company control socket, `runuser/env -i` process boundary, shelling into `scripts/autonomous-goal-operator.ts`, and duplicated episode lifecycle become obsolete after the new path qualifies.

## Exact-head review iteration

The first committed draft (`635f73a3cc25edb29e991994455e4c167b422bf9`) was reviewed separately against #466, `AGENTS.md`, and the current runtime code before this revision.

The review kept the architecture but tightened four seams that could otherwise invite unnecessary machinery:

1. **Provider selection is existing interactive state, not autonomy configuration.** Approval uses the authenticated chat's already-resolved interactive CLI preference. The resulting `autonomous_goals.bot` value is the durable provider choice for that episode and is used again during restart recovery.
2. **Single-active creation belongs atomically beside `createAutonomousGoal()`.** Add one narrow generic create-if-no-active helper that performs the active check, goal insert, and initial wake in one transaction. Do not add a lifecycle table or unique-index scheme.
3. **Workspace context reuses `loadWorkspaceContext()`.** Optional pack `CONTEXT.md` is loaded through the existing helper using an explicit copied env object; no process-global env mutation and no second Skills/context loader.
4. **Impossible recovery state fails closed.** The first implementation permits one configured autonomy workspace. More than one active goal is corruption/invariant failure, not a reason to add a scheduler.

The review also rechecked the rejected machinery: no legacy-data migration, owner-gate/episode-series table, persisted `awaiting_owner`, pause state, worker/timer, second poller, profile registry, notification socket/cursor, provider abstraction, or Farstax/Company schema is justified.

## What this plan deliberately does not preserve

The current Company execution state is not a production state worth migrating.

The new path starts with a **fresh, current-schema Agent Bridge database** dedicated to autonomous execution. The old Company database and Platform Company episode rows are not copied, transformed, linked, reconciled, dual-written, or assigned replacement IDs.

Authoritative business facts such as beta funnel/customer state remain in Platform because they are business-system facts, not autonomous-runtime state.

There is no compatibility migration and no dual-run period. During qualification the old execution path can remain installed but disabled. Rollback means reverting the feature/config/release to the previous deployment state; it does not mean synchronizing old and new Company execution state, and it does not require a reverse data migration.

## Company definition: files, not runtime schema

Farstax owns a versioned Company pack. A representative layout is:

```text
company/
  AUTONOMY.md
  CONTEXT.md
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

Only three names may have generic runtime meaning in the first implementation:

- `AUTONOMY.md`: required owner-authorized episode entry instruction/prompt;
- `CONTEXT.md`: optional managed workspace context, loaded through the existing workspace-context loader;
- `SOUL.md`: optional Soul, loaded through the existing Soul loader.

The other Markdown files are ordinary workspace content. Agent Bridge does not parse `mission.md`, `goals.md`, `constraints.md`, or any Farstax-specific structure. Providers can inspect them normally because execution cwd is the pack root.

Skills continue to use the existing Skills installation/projection mechanism. Autonomy does not introduce a Skills loader. When `CONTEXT.md` exists, composition code calls existing `loadWorkspaceContext()` with an explicit copied env pointing to that file so the existing managed-context/Skills instructions are preserved without mutating `process.env`.

This keeps the OSS boundary generic:

> Agent Bridge executes an owner-authorized autonomous episode in a configured workspace. It does not know that the workspace represents a company, mission, funnel, growth plan, or business.

SQLite contains only execution state that genuinely needs durability/concurrency semantics: goals, wakes, ordinary Runs, cancellation, cycle budget, and bounded evidence.

## Existing primitives to reuse unchanged

`src/autonomousGoalRuntime.ts` already owns the hard lifecycle:

- `createAutonomousGoal()` atomically creates a durable goal and initial wake;
- `runNextAutonomousGoal()` claims a wake, creates an ordinary `bridge_runs` row, acquires the existing `autonomous:<goalId>` execution lane and invokes `BridgeEngine.executeSurfaceNeutralTurn()`;
- `drainAutonomousGoal()` executes bounded successor wakes without introducing another executor;
- claimed-but-unreconciled wakes are not blindly replayed after restart;
- cycle budgets are rechecked at the actual Run-claim boundary;
- bounded evidence is persisted on the existing goal;
- cancellation uses ordinary Run/descendant ownership;
- cycle reconciliation already exposes a bounded `CycleReconciledEvent` observer seam.

`src/cliSupervisor.ts` and `src/cli.ts` already accept explicit child-process cwd and bounded `contextEnv`. Provider execution therefore does not need a new provider abstraction or process-global environment virtualization.

`src/workspaceContext.ts` already accepts an explicit `NodeJS.ProcessEnv` when loading managed context. Use that seam; do not replace it.

`src/index-interactive.ts` already owns the single authenticated Telegram poller, current CLI preference resolution, normal provider configuration, and owner delivery.

The standalone operator remains useful as a diagnostic/manual CLI, but production Company execution must stop depending on Platform spawning it.

## Three options considered

### Option 1 — refine current Platform orchestration

```text
Telegram -> Agent Bridge -> Platform Company socket -> runuser/env -i
        -> standalone OSS operator -> BridgeEngine -> provider
```

Platform continues to own start/stop/status and translates those operations into standalone operator invocations.

Advantages:

- smallest immediate behavior change;
- process-level cwd/env isolation is obvious.

Costs:

- two lifecycle owners;
- Platform understands OSS execution details;
- Company-specific Unix socket and process protocol remain;
- process spawning and JSONL translation remain;
- cancellation/restart/status have duplicate representations;
- deployment must keep a separate execution boundary synchronized with OSS.

**Reject.** It retains the architecture #466 exists to remove.

### Option 2 — first-class autonomy in the existing interactive process

```text
Telegram -> Agent Bridge interactive process
              |-> normal interactive Runs
              `-> generic autonomous episode -> ordinary Run -> provider
```

The interactive process opens a separate autonomy Bridge DB and constructs the episode engine with explicit cwd/context/Soul while reusing the current provider configuration and authenticated owner surface.

Advantages:

- one poller and one runtime identity;
- no Platform execution socket;
- no `runuser/env -i` Company bridge;
- no standalone operator dependency in production;
- ordinary Run/provider/cancellation paths remain authoritative;
- Company definition remains files/Skills outside OSS semantics.

Risk:

- `BridgeEngine` currently resolves execution cwd/workspace context through process-global defaults in several paths.

**Recommend**, subject to the explicit-context proof in Slice 1. If that proof requires a broad provider/environment redesign, stop and use Option 3.

### Option 3 — dedicated generic OSS autonomous service

```text
Telegram -> Agent Bridge interactive process -> local generic autonomy control
                                           -> Agent Bridge autonomous service
                                           -> ordinary Run -> provider
```

The second process provides natural cwd/env isolation while the interactive process remains the only Telegram poller.

Advantages:

- clean process isolation;
- Platform still loses Company execution ownership.

Costs:

- another service/process;
- another local control boundary;
- more restart/deployment configuration than Option 2.

**Fallback only** if Slice 1 proves safe in-process isolation is not a small change.

## Smallest generic runtime contract

The first implementation supports **one configured autonomous workspace per interactive service instance**. Do not build a profile registry or multi-autonomy scheduler before a second real use case exists.

Only two new runtime configuration values are planned:

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/company
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
```

Do not add autonomy-specific provider, credential, Soul path, context path, Skills path, HOME, PATH, or arbitrary env-overlay settings.

Conventions:

- execution cwd = `AGENT_BRIDGE_AUTONOMY_DIR`;
- entry prompt = `<dir>/AUTONOMY.md`;
- optional managed context = `<dir>/CONTEXT.md`;
- optional Soul = `<dir>/SOUL.md`;
- provider = current authenticated chat's existing resolved interactive CLI preference at approval time;
- provider configuration/credentials = the normal interactive Agent Bridge service configuration/runtime user;
- Skills = existing CLI Skills projection;
- runtime DB = separate normal Bridge DB at `AGENT_BRIDGE_AUTONOMY_DB_PATH`.

The provider choice is stored by the existing `autonomous_goals.bot` field. A restart uses that stored field; it does not recompute the provider from whatever the interactive preference has become later.

Cycle budget uses the existing bounded default initially. Add a separate autonomy max-cycle setting only if real qualification demonstrates a need; do not add it pre-emptively.

Configuration rules:

- both path settings absent -> autonomy disabled;
- exactly one present -> startup configuration error;
- both present -> canonicalize paths and fail if the autonomy DB resolves to the interactive DB;
- `AUTONOMY.md` missing/unreadable/empty -> fail closed before accepting approval;
- optional context/Soul missing -> explicit absence, never fall back to the interactive workspace's process-global context/Soul.

## Owner lifecycle: the existing goal is the authorization

Do not add an `autonomy_series`, `episode`, `owner_gate`, or Company table.

One `/autonomy approve` means: **the authenticated owner authorizes exactly one new bounded autonomous goal**.

The `autonomous_goals` row is the durable authorization record. Its initial wake is created in the same transaction. There is no separately persisted `awaiting_owner` state.

Derived presentation state:

- exactly one active goal -> `running`;
- no active goal + latest terminal goal -> `awaiting owner` with latest result;
- no goal -> `not started / awaiting owner`;
- more than one active goal -> invariant failure; fail closed and surface the error.

Terminal status remains the existing `complete`, `blocked`, `cancelled`, or `budget_exhausted`.

A terminal goal never creates the next top-level goal. Only another authenticated owner approval can do so.

### Goal identity

Each approval generates an opaque ID such as `autonomy:<uuid>`. It contains no Farstax, Company, funnel, mission, or legacy identity.

### Only three commands initially

```text
/autonomy status
/autonomy approve
/autonomy stop
```

No `pause`. Pause introduces resumability semantics that the Farstax acceptance path does not require and that are not equivalent to existing cancellation.

`approve` returns after durable authorization and in-process drain scheduling. It never awaits the episode from the Telegram handler.

`stop` delegates to existing autonomous cancellation. It never owns another kill/fence mechanism.

## Provider selection and engine construction

Provider choice must be explicit enough to be restart-safe without becoming new configuration.

On `/autonomy approve`:

1. `index-interactive.ts` resolves the authenticated chat's provider through the same existing preference/availability path used for ordinary interactive work (`resolveCredentialCheckedPreference(chatKey)` or its existing equivalent at implementation time).
2. If no normal provider is available, fail before writing a goal.
3. Pass that `BotKind` to the autonomy controller.
4. Store it through existing `createAutonomousGoal*()` into `autonomous_goals.bot`.
5. Construct the autonomous `BridgeEngine` from the already loaded normal `config.bots[bot]` and existing `resolveExecutionMode(bot, process.env)` composition state.

On restart recovery:

1. read the active goal;
2. take `goal.bot` as authoritative;
3. construct the engine from the same normal provider configuration;
4. if that provider is no longer launchable, fail closed/report configuration error and leave the durable wake unclaimed rather than silently switching provider.

Do not add `AGENT_BRIDGE_AUTONOMY_PROVIDER`, a provider registry, or autonomous provider fallback logic.

## Workspace/Soul context construction

At composition time, not inside provider code:

1. resolve the pack root from `AGENT_BRIDGE_AUTONOMY_DIR`;
2. read bounded non-empty `AUTONOMY.md` for the goal prompt;
3. if `CONTEXT.md` exists, call existing `loadWorkspaceContext()` with an **explicit copied env object** whose `AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE` points to that file;
4. if `CONTEXT.md` is absent, pass explicit empty workspace context so the autonomous engine does not inherit the interactive process's workspace context;
5. load optional `SOUL.md` through existing Soul functions and pass the resulting `soulContext` explicitly;
6. pass pack root as explicit execution cwd.

No step assigns to `process.env` or calls `process.chdir()`.

The existing shared-Skills/native Skills configuration remains authoritative. There is no autonomy-specific Skills discovery or projection code.

## Runtime module shape

Add one small generic module, tentatively `src/autonomyControl.ts`. It is an adapter over existing primitives, not another engine.

Responsibilities:

1. own the dedicated autonomy DB connection lifecycle;
2. validate/canonicalize the two configured paths and enforce DB isolation from the interactive DB;
3. load the generic pack entry/context/Soul using existing loaders;
4. expose `status()`, `approve({ bot })`, and `stop()`;
5. call existing autonomous-goal create/drain/cancel primitives;
6. perform one bounded startup recovery pass;
7. surface existing `CycleReconciledEvent` values through callbacks;
8. close the second DB on interactive service shutdown.

The controller receives a narrow engine factory/callback from the composition root so it does not learn how provider commands/credentials are configured. This is the same dependency direction already used by `drainAutonomousGoal(db, goalId, engine)`; it is not a new provider abstraction.

It must not:

- poll on a timer;
- own a worker loop;
- parse business Markdown structure;
- manage credentials;
- create a notification socket;
- create another command framework;
- mutate process-global cwd/env;
- add a scheduler;
- persist another lifecycle model.

## Slice 1 — explicit `BridgeEngine` execution context

**Purpose:** prove Option 2 is safe before adding owner UX.

Expected production files:

- `src/engine.ts`;
- `src/workspaceContext.ts` only if a tiny helper is needed to prepend an already-loaded context string without duplicating formatting.

Minimum `BridgeEngineOptions` additions:

```ts
executionCwd?: string;
workspaceContext?: string | null;
```

Recommended implementation shape inside `BridgeEngine`:

```ts
private executionCwd(kind: BotKind): string {
  return this.options.executionCwd ?? getCliWorkingDir(kind);
}

private withWorkspaceContext(prompt: string): string {
  if (this.options.workspaceContext === undefined) {
    return prependWorkspaceContext(prompt); // existing behavior
  }
  return prependAlreadyLoadedWorkspaceContext(prompt, this.options.workspaceContext);
}
```

Names are illustrative; behavior is not.

Required semantics:

- options absent -> existing behavior exactly;
- explicit cwd -> every provider invocation for that engine uses it;
- retries/model fallback/continuation paths cannot fall back to global cwd;
- explicit workspace context (including explicit empty) -> never re-read the process-global workspace-context setting;
- existing explicit `soulContext` remains unchanged;
- child-process env scrubbing remains in the existing CLI supervisor;
- no full environment overlay is added.

Expected red tests before implementation:

- `test/engine.test.ts`: two engines in one process use different explicit cwd values and each CLI invocation receives the correct one;
- `test/engine.test.ts`: retry/model fallback retains explicit cwd;
- `test/runtimeIsolation.test.ts`: those executions leave `process.cwd()` and relevant `process.env` unchanged;
- `test/workspaceContext.test.ts` only if formatting/helper behavior changes: explicit context/explicit empty context cannot bleed from process-global configuration.

All existing engine/provider tests remain green without new options.

### Slice 1 kill-switch

Stop Option 2 if the tests require any of:

- `process.chdir()` swapping;
- temporary `process.env` mutation;
- virtualized full env threaded through the provider stack;
- a provider-launch abstraction beside existing `runCli`/`runSupervisedProcess`;
- provider-specific autonomous execution code.

If so, implement Option 3. Do not grow Option 2 into a framework.

## Slice 2 — atomic generic autonomy controller

Expected production files:

- `src/autonomousGoalRuntime.ts`;
- new `src/autonomyControl.ts`;
- no schema migration.

Expected tests:

- new `test/autonomyControl.test.ts`;
- focused additions to `test/autonomousGoalRuntime.test.ts` and `test/autonomousGoalCancellationFence.test.ts` only for lower-level invariants.

### 2A. One narrow atomic creation helper

Add a generic helper beside `createAutonomousGoal()`, conceptually:

```ts
createAutonomousGoalIfNoneActive(db, input)
  -> { created: boolean; goal: AutonomousGoal }
```

Implementation requirements:

- one SQLite transaction owns the active-goal query, goal insert, and initial wake insert;
- if exactly one active goal exists, return it with `created:false`;
- if more than one active goal exists, throw an invariant error;
- if none exists, insert using the same validation/SQL/wake semantics as `createAutonomousGoal()` and return `created:true`;
- factor a private insertion helper if necessary so `createAutonomousGoal()` and the conditional helper do not duplicate goal/wake SQL;
- no new table, column, index, repository class, or series identifier.

This helper is generic because "at most one active autonomous goal in this DB" is the actual first-use concurrency contract. The dedicated DB scopes that contract to the configured autonomy workspace.

### 2B. `approve({ bot })`

1. Validate configured pack and DB isolation.
2. Read bounded `AUTONOMY.md`.
3. Receive the already-resolved normal `BotKind` from the authenticated surface composition root.
4. Generate opaque goal ID.
5. Call `createAutonomousGoalIfNoneActive()` with the prompt, generic authority constraint, provider, and existing bounded default cycle count.
6. If `created:false`, return the existing running goal; do not start another drain.
7. If `created:true`, create the engine for the stored bot and schedule `drainAutonomousGoal()` on a detached promise with explicit `.catch()`.
8. Return goal ID/status immediately.

The controller never interprets provider output as permission to start another top-level goal.

### 2C. `status()`

Return a bounded generic view:

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

Rules:

- zero active -> `awaiting_owner`, optionally show latest terminal goal ordered by `created_at`;
- one active -> `running` using that goal;
- more than one active -> invariant error;
- no history/list API in the first implementation;
- `awaiting_owner` is derived presentation only, never a DB status.

Do not create a repository layer just for these two bounded queries; keep them adjacent to the controller/runtime unless another consumer appears.

### 2D. `stop()`

1. Resolve active goal with the same zero/one/many invariant.
2. Zero -> return awaiting-owner state idempotently.
3. One -> delegate to existing `cancelAutonomousGoal()`.
4. Return existing goal status.

No process-kill code is added to the controller.

### 2E. Startup recovery

After opening the dedicated autonomy DB and before the autonomy control surface is reported ready:

- query active goals once;
- zero -> no action;
- exactly one -> construct engine from **stored `goal.bot`** and launch one detached existing drain/recovery path;
- more than one -> fail closed/report invariant error and launch none;
- unclaimed wake may continue;
- claimed wake follows existing no-blind-replay recovery behavior;
- terminal goals never restart;
- no timer/poller is created.

Tests must cover restart between goal+wake commit and claim, restart after claim before reconciliation, missing stored provider at restart, and >1 active invariant failure.

## Slice 3 — existing authenticated Telegram owner surface

The controller is surface-neutral. First production wiring targets the existing Telegram interactive service because that is the Farstax cutover path.

Expected production files:

- `src/index-interactive.ts`;
- `src/interactiveBot.ts` only for command registration/help metadata if required.

Use existing interactive authorization and command routing. Do not add another dispatcher.

### `/autonomy approve`

1. normal Telegram owner authorization has already succeeded;
2. derive `chatKey` through the existing interactive helper;
3. resolve current available CLI preference through the same existing path as ordinary work;
4. call `controller.approve({ bot: resolvedPreference })`;
5. send immediate durable goal/running response;
6. do not await episode drain.

### `/autonomy status`

Return compact current/last bounded state from `controller.status()`.

### `/autonomy stop`

Call `controller.stop()` and report the existing cancellation/terminal state.

### Async progress/terminal delivery

The controller exposes lifecycle callbacks. `index-interactive.ts` adapts them directly to existing `TelegramClient`/`sendTelegramMessage` delivery.

Do **not** route same-process autonomy messages through `ownerNotificationIngress`; that socket exists for other local processes and adds no value here.

Only already-bounded `CycleReconciledEvent` fields may be delivered. No raw provider stdout, transcript, tool log, or hidden reasoning.

Delivery failure never changes reconciled autonomous state. `/autonomy status` remains authoritative.

No notification cursor/queue is added unless a later concrete requirement proves at-least-once progress notification is required. The first requirement is durable execution state, not guaranteed chat delivery of every progress event.

Expected red tests:

- unauthorized Telegram update cannot invoke autonomy;
- approved provider equals the chat's existing resolved interactive CLI preference;
- unavailable provider fails before goal creation;
- approve responds without awaiting a held episode provider promise;
- status and stop remain usable while episode drain is running;
- bounded cycle/terminal callback uses existing delivery path;
- no second poller/socket is created.

Discord wiring is intentionally deferred. The controller API must remain surface-neutral so Discord can wire the same three commands later without runtime changes.

## Slice 4 — installation and real qualification

The feature is not accepted on unit tests alone.

The owning install/deploy layer must provision:

- the versioned Company pack readable by the normal non-root Agent Bridge runtime user;
- a **fresh** current-schema autonomy Bridge DB distinct from the interactive DB;
- the two autonomy path settings;
- Company Skills using the existing Skills installation/projection contract.

Do not create or migrate the DB opportunistically from `/autonomy approve`; production schema ownership remains with normal install/upgrade tooling.

Real-runtime qualification must prove:

1. only the existing interactive Telegram process polls the bot token;
2. `/autonomy approve` returns promptly and creates one durable goal/wake;
3. provider is the owner's existing resolved interactive CLI preference and `goal.bot` persists it;
4. provider process runs as the normal non-root Agent Bridge runtime user;
5. provider cwd is exactly the pack root;
6. optional Company context/Soul and existing projected Skills are visible through normal mechanisms;
7. autonomy DB and interactive DB are canonically distinct;
8. normal interactive work still uses its own cwd/context/Soul and cannot inherit the autonomy pack;
9. `/autonomy status` works during the autonomous Run;
10. `/autonomy stop` uses existing cancellation and fences provider descendants;
11. restart after authorization before claim resumes exactly once;
12. restart after claim never blindly replays a potentially started provider call;
13. restart uses stored `goal.bot`, not current interactive preference;
14. multiple active goals fail closed rather than being scheduled;
15. terminal episode never creates a successor top-level goal;
16. a new owner approval after terminal state creates a fresh goal;
17. progress/terminal evidence returns asynchronously through existing Telegram delivery;
18. no old Company execution DB/row is read or imported.

Provider coverage is the normal Claude/Codex/Agy path. Do not add provider-specific autonomy qualification machinery.

## Slice 5 — Platform clean cutover

This is a separate Platform PR after the OSS runtime exists.

Reuse the existing Platform-owned `company/` assets and `scripts/install-company-assets.sh`; evolve them into/install the pack rather than creating a parallel Company configuration system.

Platform cutover responsibilities:

1. version/install the Farstax Company Markdown/Soul/Skills pack;
2. add the generic entry/context files required by the new runtime;
3. provision a fresh current-schema autonomy DB;
4. configure `AGENT_BRIDGE_AUTONOMY_DIR` and `AGENT_BRIDGE_AUTONOMY_DB_PATH` on the existing interactive service;
5. keep beta/funnel/customer/business facts in their current authoritative stores;
6. disable the old Platform Company execution path;
7. execute one real owner-authorized Telegram episode and the qualification matrix above.

Explicitly do **not**:

- copy the old Company DB;
- import old `autonomous_goals`;
- preserve old episode IDs;
- dual-write Platform and OSS lifecycle state;
- translate `company_events` into new runtime rows;
- synchronize rollback state;
- reset or migrate business/funnel facts.

The previous execution database can remain untouched for short-lived forensic/cleanup convenience, but it has no runtime role in the new path.

## Slice 6 — Platform subtraction

After qualification, remove the duplicated Platform execution machinery in a separate subtraction PR.

Known deletions:

- `src/control-plane/companyControl.ts`;
- `src/control-plane/companyOperatorProcessBoundary.ts`;
- `/run/agent-bridge-platform-company.sock` ownership/configuration;
- Company control server startup/shutdown glue in `src/control-plane/index.ts`;
- shell construction around `scripts/autonomous-goal-operator.ts`;
- `runuser --user ... /usr/bin/env -i` Company execution wrapping;
- Company-specific standalone runtime env-file/runtime-user/home configuration;
- Platform parsing/polling of `autonomous_cycle_reconciled` and `goal_result` JSONL;
- Platform episode execution state that only mirrors OSS running/terminal lifecycle;
- dedicated process-boundary/control tests and docs for the deleted contract.

The standalone OSS operator may remain as a diagnostic/manual CLI. Farstax production simply stops spawning it.

Platform keeps:

- SaaS/customer/workspace/provisioning/security/public service state;
- authoritative business/funnel/customer facts;
- Company Markdown content;
- Company Soul and Skills;
- domain code needed to obtain/update those business facts.

## Failure, restart, cancellation, concurrency

### Authorization crash window

The conditional creation helper commits the goal and initial wake atomically. If the process dies after commit but before the detached drain starts, startup recovery sees that active goal/wake.

### Provider ambiguity crash window

If a wake was already claimed into an ordinary Run, preserve existing `recoverUnreconciledWake()` behavior: do not replay the provider; reconcile blocked/cancelled with bounded evidence.

### Provider configuration loss

If restart cannot construct the provider stored in `goal.bot`, do not silently select another provider and do not consume the wake. Surface a configuration error so the normal provider configuration can be repaired.

### Cancellation

`/autonomy stop` delegates to existing autonomous/ordinary Run cancellation and descendant fencing. A later episode always requires a new owner approval.

### Concurrent approvals

The generic conditional-create transaction is the only new concurrency seam. It guarantees at most one active goal in this dedicated DB. No scheduler/table/index is added.

### Impossible multiple-active state

If corruption/manual intervention produces >1 active goal, status/startup/stop fail closed. Do not choose one and do not create a multi-goal scheduler to compensate.

### Ordinary interactive concurrency

Autonomous Runs retain `surface=autonomous` and `chatKey=autonomous:<goalId>`. Existing execution-lane/worktree locking remains the final concurrency authority.

## Test-first implementation sequence

Each behavior change follows repository red/green commit discipline.

### PR A — explicit execution context

Commit A1 (red):

- explicit cwd isolation;
- explicit/empty workspace-context isolation;
- fallback/retry retains explicit cwd;
- no process-global cwd/env mutation.

Commit A2 (green):

- add the two narrow `BridgeEngineOptions` fields and route existing execution paths through them.

Then perform exact-head independent review. If changes spread into provider-specific/global-env machinery, stop Option 2 and take Option 3.

### PR B — atomic autonomy controller

Commit B1 (red):

- conditional create commits one goal+wake;
- duplicate/concurrent approval returns existing active goal;
- >1 active fails closed;
- status is derived;
- stop delegates to existing cancellation;
- restart recovers unclaimed wake, never blindly replays claimed wake;
- restart uses stored provider.

Commit B2 (green):

- add the narrow conditional-create primitive and `src/autonomyControl.ts` adapter.

No migration commit.

### PR C — Telegram owner surface

Commit C1 (red):

- auth boundary;
- current interactive provider selection;
- immediate approve response;
- status/stop during running episode;
- bounded async lifecycle delivery.

Commit C2 (green):

- wire controller into existing interactive composition/routing/delivery.

### PR D — Platform cutover

- install pack + fresh DB + two config values;
- no legacy-data import;
- real qualification evidence.

### PR E — Platform subtraction

- delete obsolete Company execution process/socket/lifecycle/config/tests/docs.

Keep PR D and E separate unless production qualification can be preserved with immediate subtraction. Do not create a compatibility layer merely to make them one PR.

## Expected subtraction

Known Platform production deletion begins with roughly 26 KB from `companyControl.ts` and `companyOperatorProcessBoundary.ts` alone, before startup glue/config/JSONL translation/lifecycle code. Dedicated tests for those two boundaries add roughly another 21 KB of removable surface.

OSS additions should remain concentrated in:

- two optional explicit-context fields/uses in `BridgeEngine`;
- one narrow conditional-create helper in the existing autonomous runtime;
- one thin `autonomyControl.ts` adapter;
- small Telegram composition/command wiring;
- focused tests.

Runtime concepts removed from Farstax production:

- Company Unix socket;
- cross-process Company control protocol;
- transient `tsx` operator launches;
- `runuser/env -i` Company execution boundary;
- duplicated Platform execution lifecycle;
- legacy execution-state migration/compatibility concerns.

Runtime concepts explicitly not added:

- Company/organization OSS model;
- scheduler;
- worker;
- second poller;
- profile registry;
- episode-series table;
- owner-gate table;
- persisted awaiting-owner state;
- pause lifecycle;
- notification bus/cursor;
- provider registry/fallback for autonomy;
- generic environment virtualization.

## Acceptance for #466

The spike is complete when the implementation direction remains all of the following after exact-head review:

- Agent Bridge stays generic; Farstax semantics stay in files/Skills/Platform business systems;
- Company definition is Markdown/Soul/Skills/workspace content;
- SQLite is fresh runtime execution state only;
- no legacy execution-data migration or compatibility layer;
- existing autonomous goals/wakes/Runs/provider/cancellation/delivery are reused;
- one owner surface and one Telegram poller;
- current interactive provider preference authorizes the episode provider, then existing `goal.bot` makes that choice durable;
- no new scheduler/orchestrator/subagent framework;
- explicit in-process cwd/context isolation is proven first;
- Option 3 is selected instead if that proof requires invasive provider/global-env work;
- Platform Company execution machinery is deleted after clean-cutover qualification.

The implementation objective is subtraction: make autonomous execution a normal Agent Bridge capability, then remove the special Platform machinery that was compensating for its absence.
