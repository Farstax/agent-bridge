# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Proceed with **Option 2: promote the existing autonomous-goal runtime into a first-class capability of the existing interactive Agent Bridge service**.

Do not build a Company runtime in OSS. Do not build a second orchestration framework. Do not migrate legacy Company execution data.

The intended runtime topology is:

```text
Farstax Company pack (Markdown + Soul + Skills)
                    |
                    v
        current start policy
     (today: owner approval)
                    |
                    v
 existing Agent Bridge interactive process
                    |
                    v
       separate autonomy Bridge DB
                    |
                    v
          bounded autonomous episode
                    |
                    v
 wake -> cycle -> ordinary Run -> reconcile
                    |                    |
                    `------ progress ----'
```

There is one Telegram poller, one Agent Bridge runtime identity, one provider execution path, one ordinary Run owner, one cancellation path and one autonomous execution lifecycle owner.

The current Platform Company socket, `runuser/env -i` process boundary, shelling into `scripts/autonomous-goal-operator.ts`, JSONL translation and duplicated execution lifecycle become obsolete after the new path qualifies.

## Clarified model: Goal -> Episode -> Cycle -> Run

Use these terms consistently:

- **Goal**: the persistent domain/business outcome. For Farstax this belongs in Company files and authoritative business systems, not OSS runtime schema.
- **Episode**: one bounded autonomous attempt toward that goal.
- **Cycle**: one autonomy-control iteration inside the episode: claim one durable wake, execute one ordinary Bridge Run, reconcile the bounded result, and either terminate or create the next wake.
- **Run**: the existing Agent Bridge execution primitive that invokes Claude/Codex/Agy and owns execution, cancellation and descendant fencing.

The existing OSS schema/type is named `autonomous_goals`. Operationally one row is the bounded **episode** in this hierarchy. Do not rename the schema merely to make terminology perfect.

There is no separate "cycle goal". Every cycle works toward the same episode prompt. Existing `buildPrompt()` already gives each cycle:

- the original episode prompt;
- retained bounded prior evidence;
- the current cycle number;
- the successor wake reason.

Existing reconciliation already behaves correctly:

```text
cycle Run result
  |- complete / blocked / cancelled -> episode terminal
  `- progress
       |- budget remains -> one successor wake
       `- last allowed cycle -> budget_exhausted
```

Do not add another cycle-state model.

## Company state is observed, not mirrored

Company-specific current reality is not OSS runtime state.

For Farstax, the Company pack/Skills must instruct the provider to read authoritative Company state from the existing Platform DB/report seams:

1. at the beginning of the first cycle, before choosing material work;
2. again at the beginning of every continuing cycle, before choosing the next material action;
3. additionally during a Run whenever fresh inspection is useful.

That means a continuing cycle receives both:

```text
bounded prior cycle evidence + wake reason
                    plus
fresh authoritative Company observation
```

A cycle may cause real systems to change. Agent Bridge persists bounded execution evidence; it does **not** copy or mutate Platform business state merely to carry reasoning forward. The next cycle re-observes authoritative systems to learn what is now true.

Do not add a generic sensor framework, sensor table, Company-state API, polling daemon or context-refresh worker to OSS.

## Owner approval is temporary experiment policy

The current one-owner-approval-per-episode behavior is a supervised-experiment policy, not a permanent autonomous-runtime mechanic.

Therefore the core controller must expose a policy-neutral operation equivalent to:

```ts
start({ bot, maxCycles, initialEvidence? })
```

Today the authenticated Telegram `/autonomy approve` adapter is the policy allowed to call `start()`. Later another explicitly-authorized policy may start a successor without changing the autonomous DB schema, wake processing, Run execution, cancellation or restart semantics.

Do not persist generic states such as:

- `owner_approved`;
- `awaiting_owner`;
- approval series/episode series;
- owner-gate rows.

A terminal episode must not auto-create a successor while the current experiment policy is enabled, but that rule belongs in the thin policy/composition adapter, not in `createAutonomousGoal()`, `runNextAutonomousGoal()`, provider execution or restart recovery.

Generic status should describe execution state such as `idle`, `running` and latest terminal result. The current owner surface may render `idle + latest terminal` as "awaiting owner" for the experiment, but OSS persistence must not know that term.

## Previous episode continuity without a series model

Within an episode, existing bounded evidence already feeds the next cycle.

Across episodes, previous terminal evidence is useful reasoning context but is not authoritative Company business truth. Preserve continuity without another lifecycle store:

- `createAutonomousGoal()` already supports `initialEvidence`;
- the generic controller accepts optional bounded `initialEvidence` at `start()`;
- the current Farstax policy adapter may seed the next episode with the latest terminal episode evidence and any current policy/owner correction;
- fresh Company truth is still re-read through Company Skills.

Do not add an episode-series table, history migration or Platform mirror simply to pass the previous review forward.

## Company definition: files, not runtime schema

Farstax owns a versioned Company pack. Representative shape:

```text
company/
  AUTONOMY.md
  CONTEXT.md              # optional static managed workspace context only
  mission.md
  goals.md
  operating-model.md
  constraints.md
  SOUL.md
  skills/
    farstax-platform-operations/SKILL.md
    farstax-company-state/SKILL.md
    farstax-editorial-gate/SKILL.md
    farstax-voice/SKILL.md
```

Only these files have generic runtime meaning:

- `AUTONOMY.md`: required episode entry instruction;
- optional `CONTEXT.md`: static managed workspace context loaded through the existing workspace-context loader;
- optional `SOUL.md`: loaded through the existing Soul loader.

`CONTEXT.md` is **not** the live Company-state snapshot. Dynamic Company reality is read by Skills/tools during each cycle.

All other files are ordinary workspace content. Agent Bridge does not parse mission, growth, funnel or Company semantics.

SQLite contains only generic execution state that needs durability/concurrency semantics:

- bounded episode identity;
- provider choice;
- cycle count / max-cycle budget;
- wakes/idempotency;
- ordinary Run IDs;
- cancellation/fencing;
- bounded evidence.

## Current Farstax cycle budget

`maxCycles` is a genuine generic runtime safety boundary and remains explicit per episode.

The standalone operator currently defaults to 3 cycles. That default must **not** silently change Farstax behavior.

The current Farstax Company experiment uses **20 cycles per episode**. Preserve that by configuring/passing `20` explicitly through the generic composition path. Do not hard-code Farstax into the autonomous runtime.

Use one optional generic runtime configuration value:

```text
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=20
```

Rules:

- if omitted, preserve the existing generic default of 3;
- validate as a positive bounded integer;
- Farstax Platform deployment explicitly sets 20;
- the controller receives the resolved integer; it does not read Company files to determine a safety budget.

A `progress` result on cycle 20 ends the Farstax episode as `budget_exhausted` and creates no cycle 21. The persistent Company goal remains unfinished rather than being declared failed.

## Existing primitives to reuse

`src/autonomousGoalRuntime.ts` already owns the hard execution lifecycle:

- `createAutonomousGoal()` atomically creates a durable row plus initial wake;
- `createAutonomousGoal()` already accepts `initialEvidence`;
- `runNextAutonomousGoal()` claims a wake, creates an ordinary `bridge_runs` row, acquires the existing `autonomous:<goalId>` lane and invokes `BridgeEngine.executeSurfaceNeutralTurn()`;
- `buildPrompt()` carries original prompt, prior evidence and wake reason into every cycle;
- `reconcile()` persists bounded evidence and creates exactly one successor wake for `progress` while budget remains;
- `drainAutonomousGoal()` consumes bounded successor wakes without introducing another executor;
- claimed-but-unreconciled wakes are never blindly replayed after restart;
- cycle budgets are checked at the Run-claim/reconciliation boundary;
- cancellation uses ordinary Run/descendant ownership;
- `CycleReconciledEvent` is already a bounded observer seam.

`src/cliSupervisor.ts` / `src/cli.ts` already support explicit child cwd and bounded child context env.

`src/workspaceContext.ts` already accepts an explicit environment when loading static managed context.

`src/index-interactive.ts` already owns the authenticated Telegram poller, provider preference resolution and delivery.

The standalone operator remains a useful diagnostic/manual seam; production Company execution should stop depending on Platform spawning it.

## Three options

### Option 1 - refine current Platform orchestration

```text
Telegram -> Agent Bridge -> Platform Company socket -> runuser/env -i
        -> standalone OSS operator -> BridgeEngine -> provider
```

Advantages:

- smallest immediate behavior change;
- process cwd/env isolation is obvious.

Costs:

- duplicated lifecycle owners;
- Platform understands OSS execution details;
- Company-specific socket/process protocol remains;
- JSONL translation remains;
- cancellation/restart/status have duplicate representations.

**Reject.** It preserves the architecture #466 exists to remove.

### Option 2 - first-class autonomy in the existing interactive process

```text
existing interactive process
  |- ordinary interactive Runs
  `- generic bounded autonomous episode -> ordinary Runs
```

The interactive process opens a separate autonomy DB and constructs the autonomous engine with explicit cwd/static context/Soul while reusing normal provider configuration and the authenticated owner surface.

Advantages:

- one poller and runtime identity;
- no Platform execution socket;
- no `runuser/env -i` Company boundary;
- ordinary Run/provider/cancellation paths remain authoritative;
- Company definition/sensing stays outside OSS semantics.

Risk:

- `BridgeEngine` currently resolves cwd/workspace context through process-global defaults in some paths.

**Recommend**, subject to Slice 1 proving explicit execution context is a small change.

### Option 3 - dedicated generic OSS autonomous service

Use a second generic OSS process only if safe in-process cwd/context isolation proves invasive. It must have no second Telegram poller and Platform still must not own execution.

Costs are another service/process and local boundary, so this remains fallback only.

## Smallest generic runtime contract

First implementation supports one configured autonomy workspace per interactive service instance. Do not build a profile registry or multi-autonomy scheduler before a second real use case exists.

Generic configuration:

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # optional generic default; Farstax sets 20
```

Do not add autonomy-specific provider, credential, Soul path, Skills path, HOME, PATH or arbitrary env-overlay settings.

Conventions:

- execution cwd = `AGENT_BRIDGE_AUTONOMY_DIR`;
- entry prompt = `<dir>/AUTONOMY.md`;
- optional static managed context = `<dir>/CONTEXT.md`;
- optional Soul = `<dir>/SOUL.md`;
- provider = current start policy supplies an already-resolved normal `BotKind`;
- provider config/credentials = normal interactive Agent Bridge service configuration/runtime user;
- Skills = existing Skills projection;
- runtime DB = separate normal Bridge DB;
- cycle budget = resolved generic `AGENT_BRIDGE_AUTONOMY_MAX_CYCLES` or explicit start input.

Configuration rules:

- both required path settings absent -> autonomy disabled;
- exactly one path present -> startup error;
- canonicalize paths and fail if autonomy DB resolves to the interactive DB;
- missing/unreadable/empty `AUTONOMY.md` -> fail before start;
- optional static context/Soul missing -> explicit absence, never inherit interactive global context/Soul;
- invalid max-cycle setting -> startup error.

## Provider selection

Provider selection is existing interactive policy, not autonomy configuration.

For today's `/autonomy approve` adapter:

1. resolve the authenticated chat's provider through the same preference/availability path as ordinary interactive work;
2. if no provider is launchable, fail before episode creation;
3. call generic `controller.start({ bot, maxCycles, initialEvidence })`;
4. persist provider through existing `autonomous_goals.bot`.

On restart:

1. read the active episode row;
2. use stored `goal.bot` as authoritative;
3. reconstruct the engine from normal provider configuration;
4. if unavailable, fail closed and leave an unclaimed wake unconsumed rather than silently changing provider.

Do not add `AGENT_BRIDGE_AUTONOMY_PROVIDER` or autonomous provider fallback logic.

## Workspace/Soul construction

At composition time:

1. resolve pack root;
2. read bounded non-empty `AUTONOMY.md`;
3. load optional static `CONTEXT.md` through existing `loadWorkspaceContext()` with a copied explicit env;
4. if absent, pass explicit empty workspace context so the autonomous engine cannot inherit interactive context;
5. load optional `SOUL.md` through existing Soul functions;
6. pass pack root as explicit execution cwd.

No `process.chdir()` and no assignment to `process.env`.

Dynamic Company sensing is not performed here. It happens inside provider work through projected Company Skills.

## Runtime module shape

Add one small generic module, tentatively `src/autonomyControl.ts`.

Responsibilities:

1. own the dedicated autonomy DB connection lifecycle;
2. validate/canonicalize configuration and DB isolation;
3. load generic entry/static context/Soul using existing loaders;
4. expose policy-neutral `start()`, `status()` and `stop()`;
5. call existing create/drain/cancel primitives;
6. perform one bounded startup recovery pass;
7. surface existing `CycleReconciledEvent` callbacks;
8. close the second DB on service shutdown.

It must not:

- know Farstax/Company semantics;
- collect business state;
- poll on a timer;
- own another worker loop;
- manage credentials;
- create a socket;
- create another command framework;
- mutate global cwd/env;
- add a scheduler;
- persist owner-gate or episode-series state.

### Generic `start()`

Conceptual API:

```ts
start(input: {
  bot: BotKind;
  maxCycles: number;
  initialEvidence?: string[];
}): Promise<{ created: boolean; goal: AutonomousGoal }>;
```

The prompt comes from the configured `AUTONOMY.md`; callers cannot smuggle a separate Company schema through this API.

Use a narrow atomic helper beside `createAutonomousGoal()`:

```ts
createAutonomousGoalIfNoneActive(db, input)
  -> { created: boolean; goal: AutonomousGoal }
```

One SQLite transaction owns:

- active-row check;
- new episode row insert if none active;
- initial wake insert.

Rules:

- zero active -> create row+wake;
- exactly one active -> return it with `created:false`;
- more than one active -> invariant error/fail closed;
- reuse existing validation/SQL;
- no new table/column/index/repository/series identifier.

If created, schedule `drainAutonomousGoal()` on a detached promise with explicit error handling. `start()` returns immediately after durable creation/scheduling; it never waits for the episode.

### Generic `status()`

Return a bounded execution view, for example:

```ts
{
  state: "idle" | "running";
  current: AutonomousGoal | null;
  latestTerminal: AutonomousGoal | null;
}
```

The exposed fields should be narrowed to goal ID, status, cycle/maxCycles and bounded evidence rather than leaking prompts/credentials.

Do not persist `idle` or `awaiting_owner`.

### Generic `stop()`

Resolve the one active episode and delegate to existing `cancelAutonomousGoal()`. No second kill/fence path.

### Startup recovery

On service startup:

- zero active -> no action;
- exactly one active -> construct engine from stored provider and launch the existing drain/recovery path once;
- more than one -> fail closed;
- unclaimed wake may continue;
- claimed wake follows existing no-blind-replay semantics;
- terminal episodes never restart;
- no timer/poller.

## Slice 1 - explicit BridgeEngine execution context

Expected production files:

- `src/engine.ts`;
- `src/workspaceContext.ts` only if a tiny helper is required.

Minimum `BridgeEngineOptions` additions:

```ts
executionCwd?: string;
workspaceContext?: string | null;
```

Required semantics:

- absent options preserve existing behavior;
- explicit cwd applies to every provider invocation/retry/model fallback/continuation for that engine;
- explicit workspace context, including explicit empty, prevents global context rereads;
- existing explicit Soul behavior remains;
- no full env virtualization.

Red tests:

- two engines in one process use distinct cwd values;
- retry/fallback retains explicit cwd;
- explicit and explicit-empty workspace context cannot bleed from globals;
- process cwd/env remain unchanged.

### Kill-switch

If this requires `process.chdir()`, temporary `process.env`, full virtual env threading, a new provider-launch abstraction or provider-specific autonomy code, stop Option 2 and take Option 3.

## Slice 2 - policy-neutral autonomy controller

Expected production files:

- `src/autonomousGoalRuntime.ts`;
- new `src/autonomyControl.ts`;
- normal config parsing for the optional max-cycle setting;
- no schema migration.

Red tests:

- conditional create is atomic;
- concurrent starts create at most one active row;
- `start()` accepts explicit `maxCycles` and bounded `initialEvidence`;
- `status()` is idle/running/latest-terminal, not awaiting-owner state;
- stop delegates to existing cancellation;
- restart recovers an unclaimed wake and never replays a claimed provider boundary;
- restart uses stored provider;
- >1 active fails closed.

Do not modify the existing cycle algorithm unless a test proves a defect. Existing prior-evidence/wake continuity is the intended implementation.

## Slice 3 - current Telegram experiment adapter

Expected production files:

- `src/index-interactive.ts`;
- command metadata file only if required.

Current commands:

```text
/autonomy status
/autonomy approve
/autonomy stop
```

These are **experiment UX**, not the generic runtime API.

`/autonomy approve`:

1. normal authenticated owner boundary already succeeded;
2. resolve current available provider through existing interactive preference logic;
3. resolve configured max cycles;
4. obtain latest terminal bounded evidence when available and pass it as `initialEvidence` for continuity;
5. call generic `controller.start()`;
6. respond immediately; do not await drain.

`/autonomy status`:

- render generic runtime state;
- the adapter may describe idle-after-terminal as "awaiting owner" for today's experiment;
- do not persist that label.

`/autonomy stop`:

- call generic stop and report cancellation/terminal state.

Async cycle/terminal delivery adapts existing bounded `CycleReconciledEvent` directly to existing Telegram delivery. Do not route same-process messages through `ownerNotificationIngress` and do not add a durable notification queue merely for this experiment.

Red tests:

- unauthorized update cannot invoke autonomy;
- provider selection matches ordinary interactive preference;
- unavailable provider fails before creation;
- approve responds without waiting for provider completion;
- configured maxCycles reaches the created episode;
- previous terminal evidence can seed the next episode;
- status/stop work during drain;
- no second poller/socket.

## Slice 4 - Platform Company pack and sensing qualification

This is a Platform change tracked separately in Platform issue #352.

Reuse the existing Platform-owned `company/` assets and install path. Do not create a parallel Company configuration system.

Platform responsibilities:

1. version/install `AUTONOMY.md`, mission/goals/operating model/constraints, Soul and Skills;
2. provide a small read-only `farstax-company-state` Skill/query over existing authoritative Platform DB/report seams;
3. instruct every cycle to re-read relevant authoritative state before choosing the next material action;
4. keep deterministic business progress calculations in Platform;
5. provision a fresh current-schema autonomy DB;
6. configure autonomy paths and `AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=20`;
7. preserve useful Company business status/progress as a read-only projection, optionally composed with generic OSS runtime status at presentation time;
8. do not mirror OSS execution lifecycle into Platform tables.

Qualification must include a real two-cycle observation test:

1. cycle 1 reads Company state and returns `progress`;
2. authoritative Platform state changes before cycle 2 (or cycle 1 causes a measurable change);
3. cycle 2 receives prior bounded evidence/wake reason;
4. cycle 2 re-reads Platform state and observes the changed value;
5. no static Company-file edit or runtime DB mirror is used to make the change visible.

Also prove previous terminal evidence can reach a newly-authorized episode through bounded `initialEvidence` without Platform execution-history mirroring.

## Slice 5 - full runtime qualification

The feature is not accepted on unit tests alone.

Prove:

1. only the existing interactive Telegram process polls the token;
2. current `/autonomy approve` policy starts exactly one durable bounded episode;
3. generic controller itself contains no owner semantics;
4. provider is the existing resolved interactive provider and stored `goal.bot` survives restart;
5. provider runs as the normal non-root runtime user;
6. cwd is exactly the pack root;
7. optional static context/Soul and projected Skills are isolated from interactive execution;
8. autonomy DB and interactive DB are canonically distinct;
9. status/stop work while an autonomous Run is active;
10. restart before claim resumes exactly once;
11. restart after claim does not blindly replay provider execution;
12. each continuing cycle receives original episode prompt + retained evidence + wake reason;
13. Company Skill re-observes current authoritative state on a continuing cycle;
14. one `progress` result creates one successor wake while budget remains;
15. Farstax episode is configured for 20 cycles;
16. a `progress` result on cycle 20 yields `budget_exhausted` and no cycle 21;
17. terminal episode does not auto-create a successor under today's experiment policy;
18. a later authorized start can use previous terminal bounded evidence without a series table;
19. progress/terminal evidence returns asynchronously through existing delivery;
20. no legacy Company execution state is read/imported.

## Slice 6 - Platform subtraction

After qualification, remove duplicated Platform execution machinery in a separate subtraction PR.

Known deletions:

- `src/control-plane/companyControl.ts` execution orchestration;
- `src/control-plane/companyOperatorProcessBoundary.ts`;
- `/run/agent-bridge-platform-company.sock` ownership/config;
- Company control server startup/shutdown glue;
- shell construction around `scripts/autonomous-goal-operator.ts`;
- Company-only `runuser --user ... /usr/bin/env -i` wrapping;
- standalone Company runtime env/user/home config that becomes obsolete;
- Platform parsing/polling of autonomous JSONL;
- Platform running/terminal lifecycle state that only mirrors OSS;
- dedicated tests/docs for deleted execution boundaries.

Platform keeps:

- SaaS/customer/workspace/provisioning/security/public-service state;
- authoritative business/funnel/customer facts and deterministic calculations;
- Company Markdown/Soul/Skills;
- read-only Company-state sensing/query capability;
- useful Company business status/progress projection.

## Failure, restart, cancellation and concurrency

### Creation crash window

The conditional create transaction commits row + initial wake together. If the process dies after commit but before detached drain starts, startup recovery sees the active row/wake.

### Claimed wake crash window

Preserve existing `recoverUnreconciledWake()` behavior. A claimed provider boundary is never blindly replayed.

### Provider configuration loss

If restart cannot construct stored `goal.bot`, do not silently switch provider or consume an unclaimed wake. Surface configuration failure.

### Cancellation

Current `/autonomy stop` delegates to generic stop, which delegates to existing autonomous/ordinary Run cancellation and descendant fencing. Whether a later episode may start is a policy question, not cancellation state.

### Concurrent starts

The conditional-create transaction is the only new concurrency seam. It guarantees at most one active episode in this dedicated DB.

### Multiple-active corruption

If >1 active row exists, status/startup/stop fail closed. Do not create a scheduler to compensate.

### Ordinary interactive concurrency

Autonomous Runs retain `surface=autonomous` and `chatKey=autonomous:<goalId>`. Existing lane/worktree locking remains the final concurrency authority.

## Test-first delivery sequence

### PR A - explicit execution context

Red then green:

- explicit cwd isolation;
- static/empty workspace-context isolation;
- retry/fallback retention;
- no global cwd/env mutation.

Independent exact-head review. If invasive, switch to Option 3.

### PR B - generic controller

Red then green:

- atomic create-if-none-active;
- policy-neutral start/status/stop;
- explicit maxCycles;
- optional initialEvidence;
- restart semantics;
- stored provider;
- >1 active fail closed.

No migration commit.

### PR C - current owner-policy adapter

Red then green:

- authenticated `/autonomy approve|status|stop`;
- normal provider preference;
- max-cycle config reaches `start()`;
- previous terminal evidence seeding;
- immediate response;
- async bounded delivery.

### PR D - Platform pack/state sensing + qualification

- install/evolve Company pack;
- read-only Company-state Skill/query;
- explicit 20-cycle setting;
- multi-cycle fresh-state observation proof;
- no legacy execution import.

### PR E - Platform subtraction

- delete obsolete Company execution process/socket/lifecycle/config/tests/docs.

Do not create compatibility machinery merely to combine PR D and E.

## Expected subtraction

Known Platform production deletion begins with roughly 26 KB from `companyControl.ts` and `companyOperatorProcessBoundary.ts` before startup/config/JSONL/lifecycle removal. Dedicated tests for those boundaries contribute roughly another 21 KB of removable surface.

OSS additions remain concentrated in:

- two explicit execution-context options/uses in `BridgeEngine`;
- one narrow conditional-create helper;
- one thin policy-neutral `autonomyControl.ts` adapter;
- one generic optional max-cycle config value;
- small current Telegram policy wiring;
- focused tests.

Runtime concepts explicitly **not** added:

- Company/organization OSS model;
- sensor framework;
- scheduler;
- worker;
- second poller;
- profile registry;
- episode-series table;
- owner-gate table;
- persisted awaiting-owner state;
- pause lifecycle;
- notification bus/cursor;
- autonomy provider registry/fallback;
- generic environment virtualization.

## No legacy execution-data migration

The new path starts with a **fresh current-schema Agent Bridge autonomy DB**.

Do not:

- copy old Company DB rows;
- import old autonomous goals;
- map old/new episode IDs;
- replay history;
- dual-write lifecycle state;
- build compatibility or reverse-migration logic.

Existing Platform business/funnel/customer facts remain in their authoritative store and are read by Company Skills. Old Company execution data may remain untouched temporarily for forensics/rollback and be removed separately.

## Acceptance for #466

The plan is correct only if all remain true:

- `Goal -> Episode -> Cycle -> Run` is the shared mental model;
- existing `autonomous_goals` schema may remain named as-is;
- Agent Bridge stays generic;
- Company definition is Markdown/Soul/Skills/workspace content;
- dynamic Company truth stays in authoritative external systems and is re-observed through Skills on every continuing cycle;
- existing cycle continuity (original prompt + prior evidence + wake reason) is reused rather than replaced;
- owner approval is today's thin start policy, not permanent runtime schema/lifecycle;
- generic controller is policy-neutral `start/status/stop`;
- previous terminal evidence may seed the next episode through existing bounded `initialEvidence`, with no series table;
- `maxCycles` remains generic and explicit; Farstax sets 20 rather than relying on the standalone default of 3;
- the last permitted `progress` cycle becomes `budget_exhausted` and creates no successor wake;
- Company-level business status/progress remains outside OSS execution ownership;
- explicit in-process cwd/static-context isolation is proven first;
- Option 3 is used instead if isolation requires invasive provider/global-env work;
- no legacy Company execution migration or compatibility layer;
- no new scheduler, worker, sensor subsystem, second poller, generic orchestrator or subagent framework;
- Platform Company execution machinery is deleted after real qualification.

The implementation objective remains subtraction: make bounded autonomous execution a normal Agent Bridge capability, let domain packs observe their own authoritative world, and remove the special Platform machinery that was compensating for the missing generic capability.
