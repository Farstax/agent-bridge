# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Proceed with **Option 2: promote the existing autonomous-goal runtime into a first-class capability of the existing interactive Agent Bridge service**.

The implementation should add only the minimum generic mechanics that Agent Bridge genuinely owns, plus a reusable Skill that teaches providers how to operate inside the autonomous loop.

Do not build a Company runtime in OSS. Do not build a Company sensor framework. Do not migrate legacy Company execution data.

The intended topology is:

```text
Autonomous/domain workspace
  Markdown + Soul + Skills + ordinary tools
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

There is one Telegram poller, one Agent Bridge runtime identity, one provider execution path, one ordinary Run/cancellation owner and one autonomous execution lifecycle owner.

The current Platform Company socket, `runuser/env -i` process boundary, standalone-operator spawning, JSONL translation and duplicated execution lifecycle become obsolete after the new path qualifies.

## Shared model: Goal -> Episode -> Cycle -> Run

Use these terms consistently:

- **Goal**: persistent domain/business outcome. It belongs to the autonomous workspace and/or authoritative domain systems, not OSS runtime schema.
- **Episode**: one bounded autonomous attempt toward that goal.
- **Cycle**: one autonomy-control iteration inside the episode: claim one durable wake, execute one ordinary Bridge Run, reconcile bounded evidence, then terminate or create the next wake.
- **Run**: the existing Agent Bridge provider execution primitive.

The existing OSS schema/type is named `autonomous_goals`. Operationally one row is the bounded **episode** in this hierarchy. Do not rename existing schema merely to perfect terminology.

There is no separate cycle goal. Existing `buildPrompt()` already gives every cycle:

- the original episode prompt;
- retained bounded prior evidence;
- current cycle number;
- the successor wake reason.

Existing reconciliation already has the required control flow:

```text
cycle Run result
  |- complete / blocked / cancelled -> episode terminal
  `- progress
       |- budget remains -> one successor wake
       `- final allowed cycle -> budget_exhausted
```

Do not add another cycle-state model.

## The intelligence boundary: the agent chooses what to observe

The autonomous framework must not prescribe a fixed observation pipeline.

Before making a material decision, the provider should determine what it actually needs to know or verify and choose the cheapest reliable observation method available in its environment.

Depending on the work, that may mean:

- querying an authoritative database directly;
- inspecting files, repositories or git history;
- reading logs or service/runtime state;
- invoking an existing CLI/API;
- using projected Skills or domain tools;
- searching the web when external reality matters;
- using an existing domain-owned mechanical observation tool;
- creating a small reusable query/script/report/check if repeated need justifies mechanisation.

Prior cycle evidence is reasoning continuity. It is not automatically current authoritative truth. The provider decides which facts require re-verification.

A cycle does **not** have to call a designated sensor merely because a new cycle started. It should observe what is necessary for the next decision.

### Mechanical sensors are emergent domain artifacts

If repeated observation is expensive, error-prone, deterministic or time-sensitive enough to benefit from mechanisation, the autonomous agent may create a mechanical sensor/tool.

Examples include:

- a saved SQL query;
- a shell/Python/TypeScript script;
- a deterministic report;
- a Skill wrapping a recurring inspection method;
- a health/check command.

Those artifacts belong to the autonomous/domain workspace. They are ordinary work products that can evolve with the domain.

Agent Bridge OSS must not gain:

- a Company/domain sensor registry;
- sensor schema or mirrored domain-state tables;
- a sensor scheduler/poller;
- a mandatory context-refresh service;
- Farstax-specific observation APIs;
- a rule that each cycle invokes a particular sensor.

The architectural rule is:

> **Agent Bridge provides bounded autonomous execution and teaches its operating contract. The autonomous workspace provides intent and access to its world. The agent decides what to observe. Mechanical sensors are domain-owned optimisations that emerge from repeated need.**

## Teach autonomous work through an OSS Skill

The generic operating method belongs primarily in a reusable Agent Bridge Skill, not in Company orchestration code and not duplicated into every domain pack.

Add a Skill tentatively named:

```text
skills/autonomous-work/SKILL.md
```

Use the existing Skills installation/projection mechanism. Do not introduce an autonomy-specific Skill loader.

The Skill should teach:

1. **Understand the hierarchy**
   - persistent Goal -> bounded Episode -> Cycle -> ordinary Run;
   - the current Run is one cycle, not the whole persistent goal.

2. **Use cycle continuity correctly**
   - original episode prompt remains the objective;
   - prior bounded evidence says what previous cycles observed/did;
   - wake reason says why another cycle exists;
   - prior evidence may be stale or incomplete.

3. **Choose observation strategy dynamically**
   - ask what facts are needed before the next material decision;
   - identify the authoritative source for those facts;
   - inspect directly with normal capabilities where practical;
   - do not constrain reasoning to a predefined dashboard or sensor set.

4. **Distinguish evidence from truth**
   - provider/model evidence is execution history;
   - externally verifiable facts should be checked against authoritative systems when the decision depends on them.

5. **Act, do not merely report**
   - use the normal provider capabilities, Skills and tools to make useful progress within the episode authority/constraints.

6. **Return the runtime contract**
   - `complete` only when the bounded episode objective is actually complete;
   - `blocked` when continuation requires unavailable authority/input/capability;
   - `progress` when further useful work remains and the cycle budget permits it;
   - provide bounded evidence;
   - provide a concrete `nextWakeReason` for `progress`.

7. **Mechanise only when justified**
   - direct inspection is usually sufficient for one-off questions;
   - if an observation repeats and a deterministic helper is materially cheaper/faster/more reliable, create it in the domain workspace;
   - do not modify Agent Bridge OSS merely to create domain observation tooling.

8. **Respect the cycle budget**
   - the final permitted `progress` cycle becomes `budget_exhausted`;
   - budget exhaustion ends this episode, not the persistent domain goal.

The Skill should be provider-neutral and contain no Farstax/Company/business semantics.

## Workspace AGENTS.md is thin orientation

A domain workspace may contain `AGENTS.md`, but it should not duplicate the full autonomous-work protocol.

Its role is local orientation and hard constraints, for example:

- what this workspace represents;
- where persistent goals/mission/constraints live;
- where authoritative systems can be found or how they may be accessed;
- local security/authority constraints;
- instruction to use the projected `autonomous-work` Skill for the generic episode/cycle contract;
- confirmation that domain-owned tools may be created locally when useful.

This lets improvements to the generic autonomous operating method ship with Agent Bridge OSS while learned domain intelligence remains with the autonomous workspace.

## Domain workspace: files, not runtime schema

A representative Farstax pack is:

```text
company/
  AGENTS.md
  AUTONOMY.md
  CONTEXT.md              # optional static managed context only
  mission.md
  goals.md
  operating-model.md
  constraints.md
  SOUL.md
  skills/
  tools/                   # optional; emerges if useful
  reports/                 # optional; emerges if useful
```

Do not require `tools/`, `reports/` or `sensors/`. They exist only if the autonomous Company creates useful artifacts.

Only these names need generic runtime meaning:

- `AUTONOMY.md`: required episode entry instruction/prompt;
- optional `CONTEXT.md`: static managed workspace context loaded through the existing workspace-context loader;
- optional `SOUL.md`: loaded through the existing Soul loader.

`CONTEXT.md` is not a live domain-state snapshot. Dynamic reality is observed by the provider using normal capabilities during Runs.

Everything else is ordinary workspace content.

SQLite contains only generic state that genuinely requires execution durability/concurrency semantics:

- bounded episode identity;
- provider choice;
- cycle/max-cycle budget;
- wakes/idempotency;
- ordinary Run IDs;
- cancellation/fencing;
- bounded evidence.

## Existing primitives to reuse

`src/autonomousGoalRuntime.ts` already owns the hard lifecycle:

- `createAutonomousGoal()` atomically creates a durable goal row and initial wake;
- `createAutonomousGoal()` accepts `initialEvidence`;
- `runNextAutonomousGoal()` claims a wake, creates an ordinary `bridge_runs` row, acquires `autonomous:<goalId>` execution ownership and invokes `BridgeEngine.executeSurfaceNeutralTurn()`;
- `buildPrompt()` carries original prompt, prior evidence and wake reason into each cycle;
- `reconcile()` persists bounded evidence and creates exactly one successor wake for `progress` while budget remains;
- `drainAutonomousGoal()` consumes bounded successor wakes without introducing another executor;
- claimed-but-unreconciled wakes are never blindly replayed after restart;
- cycle budget is enforced at the execution/reconciliation boundary;
- cancellation uses ordinary Run/descendant fencing;
- `CycleReconciledEvent` is already a bounded observer seam.

`src/cliSupervisor.ts` / `src/cli.ts` already support explicit child-process cwd and bounded context environment.

`src/workspaceContext.ts` already accepts an explicit environment for static managed context.

`src/index-interactive.ts` already owns the authenticated Telegram poller, provider preference resolution and delivery.

The standalone operator remains a useful diagnostic/manual seam. Production autonomous Company execution should stop depending on Platform spawning it.

## Three options

### Option 1 — refine current Platform orchestration

```text
Telegram -> Agent Bridge -> Platform Company socket -> runuser/env -i
        -> standalone OSS operator -> BridgeEngine -> provider
```

**Reject.** It keeps duplicate lifecycle owners, a Company-specific socket/process protocol, JSONL translation and Platform knowledge of OSS execution details.

### Option 2 — first-class autonomy in the existing interactive process

```text
existing interactive process
  |- ordinary interactive Runs
  `- bounded autonomous episode -> ordinary Runs
```

The interactive process opens a separate autonomy DB and constructs the autonomous engine with explicit cwd/static context/Soul while reusing normal provider configuration, projected Skills and authenticated owner surface.

Advantages:

- one poller/runtime identity;
- no Platform execution socket;
- no Company `runuser/env -i` boundary;
- ordinary Run/provider/cancellation remain authoritative;
- domain intelligence remains in workspace/Skills/tools;
- no sensor framework.

Risk: `BridgeEngine` currently resolves cwd/workspace context through process-global defaults on some paths.

**Recommend**, subject to Slice 1 proving explicit execution context is small and safe.

### Option 3 — dedicated generic OSS autonomous service

Use a second generic OSS process only if in-process cwd/context isolation proves invasive.

It must still have no second Telegram poller, no Company/domain semantics and no Platform execution ownership.

This is fallback only because it introduces another process/service boundary.

## Smallest generic runtime contract

Support one configured autonomous workspace per interactive service instance initially. Do not build a profile registry or multi-autonomy scheduler before a second real use case exists.

Generic configuration:

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # optional generic default
```

Farstax deployment explicitly sets `AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=20`.

Do not add autonomy-specific provider, credential, Soul path, Skills path, HOME, PATH or arbitrary environment-overlay settings.

Conventions:

- execution cwd = `AGENT_BRIDGE_AUTONOMY_DIR`;
- entry prompt = `<dir>/AUTONOMY.md`;
- optional static context = `<dir>/CONTEXT.md`;
- optional Soul = `<dir>/SOUL.md`;
- provider = current start policy supplies an already-resolved normal `BotKind`;
- provider config/credentials = normal interactive service/runtime user;
- Skills = existing Skills projection;
- runtime DB = separate normal Bridge DB;
- cycle budget = resolved generic max-cycle config or explicit start input.

Rules:

- both required path settings absent -> autonomy disabled;
- exactly one required path set -> startup error;
- canonicalize DB paths and fail if autonomy DB equals interactive DB;
- missing/unreadable/empty `AUTONOMY.md` -> fail before start;
- optional static context/Soul missing -> explicit absence, never inherit interactive workspace globals;
- invalid max-cycle setting -> startup error.

## Owner approval is temporary experiment policy

The current one-owner-approval-per-episode behavior is supervised-experiment policy, not generic autonomy mechanics.

The core controller exposes policy-neutral:

```ts
start({ bot, maxCycles, initialEvidence? })
status()
stop()
```

Today authenticated Telegram `/autonomy approve` is the policy adapter allowed to call `start()`.

Do not persist:

- `owner_approved`;
- `awaiting_owner`;
- owner-gate rows;
- approval/episode-series rows.

A terminal episode must not auto-create a successor while today's experiment policy is enabled, but that rule belongs in the thin adapter/composition layer.

Generic status should be execution-oriented (`idle`, `running`, latest terminal). The Telegram experiment adapter may render idle-after-terminal as “awaiting owner” without persisting that state.

A later explicitly-authorized successor policy must be able to replace the human gate without schema/lifecycle migration.

## Episode continuity without a series model

Within an episode, reuse existing prior-evidence + wake-reason continuity.

Across episodes:

- `createAutonomousGoal()` already supports bounded `initialEvidence`;
- generic `start()` accepts optional initial evidence;
- current experiment policy may seed the next episode with the latest terminal review and an owner/current-policy correction if useful;
- the new episode independently observes whatever current reality it decides matters.

Do not add a series/history table or mirror execution history into Platform.

## Provider selection

Provider selection remains existing interactive policy, not autonomy configuration.

For today's `/autonomy approve` adapter:

1. resolve the authenticated chat's provider through the same existing preference/availability path as ordinary interactive work;
2. fail before episode creation if no provider is launchable;
3. call generic `controller.start({ bot, maxCycles, initialEvidence })`;
4. persist provider in existing `autonomous_goals.bot`.

On restart:

1. read the active episode row;
2. use stored `goal.bot` as authoritative;
3. reconstruct engine from normal provider configuration;
4. if unavailable, fail closed and leave an unclaimed wake unconsumed rather than silently switching provider.

Do not add `AGENT_BRIDGE_AUTONOMY_PROVIDER` or autonomous provider fallback logic.

## Workspace/Soul construction

At composition time:

1. resolve workspace root;
2. read bounded non-empty `AUTONOMY.md`;
3. load optional static `CONTEXT.md` through existing `loadWorkspaceContext()` with a copied explicit env;
4. if absent, pass explicit empty workspace context so the autonomous engine cannot inherit interactive context;
5. load optional `SOUL.md` through existing Soul functions;
6. pass workspace root as explicit execution cwd.

No `process.chdir()` and no assignment to `process.env`.

Dynamic observation is not performed by this composition layer. It happens inside provider Runs using the autonomous-work Skill plus normal capabilities.

## Runtime module shape

Add one small generic module, tentatively `src/autonomyControl.ts`.

Responsibilities:

1. own the dedicated autonomy DB connection lifecycle;
2. validate/canonicalize config and DB isolation;
3. load generic entry/static context/Soul using existing loaders;
4. expose policy-neutral `start()`, `status()`, `stop()`;
5. call existing create/drain/cancel primitives;
6. perform one bounded startup recovery pass;
7. surface existing `CycleReconciledEvent` callbacks;
8. close the second DB on service shutdown.

It must not:

- know Farstax/Company/domain semantics;
- collect domain state;
- own sensors;
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

The prompt comes from configured `AUTONOMY.md`.

Add one narrow atomic helper beside `createAutonomousGoal()`:

```ts
createAutonomousGoalIfNoneActive(db, input)
  -> { created: boolean; goal: AutonomousGoal }
```

One SQLite transaction owns:

- active-row check;
- episode row insert if none active;
- initial wake insert.

Rules:

- zero active -> create row+wake;
- exactly one active -> return it with `created:false`;
- more than one active -> invariant error/fail closed;
- reuse existing validation/SQL;
- no new table/column/index/repository/series identifier.

If created, schedule `drainAutonomousGoal()` on a detached promise with explicit error handling. `start()` returns after durable creation/scheduling; it never waits for the episode.

### Generic `status()`

Return a bounded execution view, for example:

```ts
{
  state: "idle" | "running";
  current: BoundedAutonomyStatus | null;
  latestTerminal: BoundedAutonomyStatus | null;
}
```

Expose only goal ID, goal status, cycle/maxCycles and bounded evidence needed by the control surface. Do not leak provider credentials, raw prompt/transcript/tool output.

Do not persist `idle` or `awaiting_owner`.

### Generic `stop()`

Resolve the one active episode and delegate to existing `cancelAutonomousGoal()`. No second kill/fence path.

### Startup recovery

On service startup:

- zero active -> no action;
- exactly one active -> construct engine from stored provider and launch existing drain/recovery path once;
- more than one -> fail closed;
- unclaimed wake may continue;
- claimed wake follows existing no-blind-replay behavior;
- terminal episodes never restart;
- no timer/poller.

## Slice 1 — explicit BridgeEngine execution context

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
- explicit/empty workspace context cannot bleed from globals;
- process cwd/env remain unchanged.

### Slice 1 kill-switch

If this requires `process.chdir()`, temporary `process.env`, full virtual env threading, a new provider-launch abstraction or provider-specific autonomy code, stop Option 2 and use Option 3.

## Slice 2 — policy-neutral autonomy controller

Expected production files:

- `src/autonomousGoalRuntime.ts`;
- new `src/autonomyControl.ts`;
- normal config parsing for optional max-cycle setting;
- no schema migration.

Red tests:

- conditional create is atomic;
- concurrent starts create at most one active row;
- `start()` accepts explicit `maxCycles` and bounded `initialEvidence`;
- `status()` is idle/running/latest-terminal rather than owner state;
- stop delegates to existing cancellation;
- restart recovers an unclaimed wake and never replays a claimed provider boundary;
- restart uses stored provider;
- >1 active fails closed.

Do not modify the existing cycle algorithm unless a test proves a defect. Existing prior-evidence/wake continuity is intentional.

## Slice 3 — autonomous-work Skill

Expected production content:

- new `skills/autonomous-work/SKILL.md`;
- existing Skill manifest/projection metadata only where current Skills machinery requires it;
- no new Skill loader/runtime.

Qualification/tests should prove:

- the Skill is projected to supported provider CLIs through the existing Skills mechanism;
- fresh and resumed provider sessions can discover/use it under the normal Skills contract;
- the Skill contains no Farstax/Company-specific semantics;
- it explicitly teaches dynamic observation selection and the difference between prior evidence and authoritative truth;
- it permits creation of domain-owned mechanical tooling when repeated need justifies it;
- it does not instruct the provider to add sensors to Agent Bridge OSS.

Do not add runtime code to enforce reasoning steps that are appropriately instructional.

## Slice 4 — current Telegram experiment adapter

Expected production files:

- `src/index-interactive.ts`;
- command metadata only if required.

Current commands:

```text
/autonomy status
/autonomy approve
/autonomy stop
```

These are experiment UX, not the generic runtime API.

`/autonomy approve`:

1. normal authenticated owner boundary already succeeded;
2. resolve current available provider through existing interactive preference logic;
3. resolve configured max cycles;
4. optionally obtain latest terminal bounded evidence/current owner correction for `initialEvidence`;
5. call generic `controller.start()`;
6. respond immediately; do not await drain.

`/autonomy status`:

- render generic runtime state;
- adapter may describe idle-after-terminal as “awaiting owner” for today's experiment;
- do not persist that label.

`/autonomy stop` delegates to generic stop.

Async cycle/terminal delivery adapts existing bounded `CycleReconciledEvent` directly to existing Telegram delivery. Do not route same-process messages through `ownerNotificationIngress` and do not add a durable notification queue merely for this experiment.

Red tests:

- unauthorized update cannot invoke autonomy;
- provider selection matches ordinary interactive preference;
- unavailable provider fails before creation;
- approve responds without waiting for provider completion;
- configured maxCycles reaches the created episode;
- previous terminal evidence can seed next episode;
- status/stop work during drain;
- no second poller/socket.

## Slice 5 — Platform Company pack handoff

Platform work is tracked separately in Platform issue #352 and should be mostly subtraction + pack extraction.

Platform should:

1. extract/install a coherent Company pack from existing Company intent/instructions/Soul/Skills;
2. add thin Company `AGENTS.md` orientation that points to the projected OSS `autonomous-work` Skill;
3. keep existing authoritative business data in existing stores;
4. provide only the access plumbing actually required for the agent to inspect permitted DB/files/repos/services/APIs;
5. **not** prebuild a mandatory Company-state sensor or observation framework;
6. allow any later mechanical observation tools to be ordinary Company-owned workspace artifacts;
7. provision a fresh autonomy DB;
8. configure `AGENT_BRIDGE_AUTONOMY_DIR`, `AGENT_BRIDGE_AUTONOMY_DB_PATH` and Farstax `AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=20`;
9. preserve useful read-only business progress/status projections without mirroring OSS execution lifecycle.

Qualification should include a real multi-cycle episode where the agent chooses what it needs to inspect and successfully uses normal permitted capabilities to observe authoritative state without a predefined Company sensor.

If an actual permission/process boundary prevents direct safe access, add the smallest access helper that solves that boundary. Do not call access plumbing a sensor architecture.

## Slice 6 — full runtime qualification

The feature is not accepted on unit tests alone.

Prove:

1. only the existing interactive Telegram process polls the token;
2. current `/autonomy approve` policy starts exactly one durable bounded episode;
3. generic controller itself contains no owner semantics;
4. provider is the existing resolved interactive provider and stored `goal.bot` survives restart;
5. provider runs as the normal non-root runtime user;
6. cwd is exactly the autonomous workspace root;
7. optional static context/Soul and projected Skills are isolated from interactive execution;
8. the new `autonomous-work` Skill is visible/usable by the provider;
9. autonomy DB and interactive DB are canonically distinct;
10. status/stop work while an autonomous Run is active;
11. restart before claim resumes exactly once;
12. restart after claim does not blindly replay provider execution;
13. each continuing cycle receives original episode prompt + retained evidence + wake reason;
14. the provider decides what facts require observation rather than being forced through a fixed sensor;
15. a provider can directly inspect permitted DB/filesystem/repository/runtime/external sources using normal capabilities when relevant;
16. one `progress` result creates one successor wake while budget remains;
17. Farstax is configured for 20 cycles;
18. a `progress` result on cycle 20 yields `budget_exhausted` and no cycle 21;
19. terminal episode does not auto-create a successor under today's experiment policy;
20. a later authorized start may use previous terminal bounded evidence without a series table;
21. progress/terminal evidence returns asynchronously through existing delivery;
22. no legacy Company execution state is read/imported;
23. no prebuilt Company sensor is required to qualify the autonomous loop.

Optional evidence, only if naturally justified during qualification: the agent creates a small reusable observation helper in the Company workspace and later uses it, with no OSS runtime/schema change.

## Slice 7 — Platform subtraction

After qualification, Platform removes duplicated execution machinery in a separate subtraction PR.

Expected deletions include:

- `src/control-plane/companyControl.ts` execution orchestration;
- `src/control-plane/companyOperatorProcessBoundary.ts`;
- `/run/agent-bridge-platform-company.sock` ownership/config;
- Company control server startup/shutdown glue;
- shell construction around `scripts/autonomous-goal-operator.ts`;
- Company-only `runuser --user ... /usr/bin/env -i` wrapping;
- standalone Company runtime env/user/home config that becomes obsolete;
- Platform parsing/polling of autonomous JSONL;
- Platform running/terminal execution lifecycle state that only mirrors OSS;
- dedicated tests/docs for deleted execution boundaries.

Platform keeps genuine SaaS/control-plane/business facts, deterministic business calculations, the Company pack/install path, necessary access plumbing and useful read-only business projections.

## Failure, restart, cancellation and concurrency

### Creation crash window

The conditional-create transaction commits episode row + initial wake together. If the process dies after commit but before detached drain starts, startup recovery sees the active row/wake.

### Claimed wake crash window

Preserve existing `recoverUnreconciledWake()` behavior. A claimed provider boundary is never blindly replayed.

### Provider configuration loss

If restart cannot construct stored `goal.bot`, do not silently switch provider or consume an unclaimed wake. Surface configuration failure.

### Cancellation

Current `/autonomy stop` delegates to generic stop, then existing autonomous/ordinary Run cancellation and descendant fencing. Whether another episode may start is a policy question, not cancellation state.

### Concurrent starts

The conditional-create transaction is the only new concurrency seam. It guarantees at most one active bounded episode in the dedicated DB.

### Multiple-active corruption

If >1 active row exists, status/startup/stop fail closed. Do not add a scheduler to compensate.

### Ordinary interactive concurrency

Autonomous Runs retain `surface=autonomous` and `chatKey=autonomous:<goalId>`. Existing lane/worktree locking remains final concurrency authority.

## Test-first delivery sequence

### PR A — explicit execution context

Red then green:

- explicit cwd isolation;
- static/empty workspace-context isolation;
- retry/fallback retention;
- no global cwd/env mutation.

Independent exact-head review. If invasive, switch to Option 3.

### PR B — generic controller

Red then green:

- atomic create-if-none-active;
- policy-neutral start/status/stop;
- explicit maxCycles;
- optional initialEvidence;
- restart semantics;
- stored provider;
- >1 active fail closed.

No migration commit.

### PR C — autonomous-work Skill

- add generic Skill using normal Skill contract;
- prove projection/discovery on supported provider CLIs;
- no new runtime loader;
- no Company semantics.

### PR D — current owner-policy adapter

Red then green:

- authenticated `/autonomy approve|status|stop`;
- normal provider preference;
- max-cycle config reaches `start()`;
- optional previous terminal evidence seeding;
- immediate response;
- async bounded delivery.

### PR E — Platform pack/access cutover

- extract/install Company pack;
- thin Company AGENTS orientation;
- required access plumbing only;
- explicit 20-cycle setting;
- real autonomous qualification without predefined sensor;
- no legacy execution import.

### PR F — Platform subtraction

- delete obsolete Company execution process/socket/lifecycle/config/tests/docs.

Do not build compatibility machinery merely to combine cutover/subtraction.

## Expected subtraction

Known Platform production deletion begins with `companyControl.ts` and `companyOperatorProcessBoundary.ts`, plus startup/config/JSONL/lifecycle surface and dedicated tests.

OSS additions stay concentrated in:

- two explicit execution-context options/uses in `BridgeEngine`;
- one narrow conditional-create helper;
- one thin policy-neutral `autonomyControl.ts` adapter;
- one generic optional max-cycle config value;
- one provider-neutral `autonomous-work` Skill;
- small current Telegram policy wiring;
- focused tests.

Runtime concepts explicitly **not** added:

- Company/organization OSS model;
- sensor framework or sensor schema;
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
- build compatibility/reverse-migration logic.

Existing Platform business facts remain in their authoritative stores. Old Company execution data may remain untouched temporarily for forensics/rollback and be removed separately.

## Acceptance for #466

The plan is correct only if all remain true:

- `Goal -> Episode -> Cycle -> Run` is the shared model;
- existing `autonomous_goals` schema may remain named as-is;
- Agent Bridge remains generic;
- Agent Bridge teaches autonomous operating behavior through a reusable provider-neutral Skill;
- workspace `AGENTS.md` stays thin/local rather than duplicating the protocol;
- dynamic reality is observed by the provider with normal capabilities, not mirrored into OSS;
- the provider chooses what to observe and how based on the current decision;
- mechanical sensors are optional domain-owned artifacts that emerge from repeated need;
- no mandatory Company-state sensor is required;
- existing cycle continuity (original prompt + prior evidence + wake reason) is reused;
- owner approval is today's thin start policy, not permanent runtime schema/lifecycle;
- generic controller is policy-neutral `start/status/stop`;
- previous terminal evidence may seed a later episode through existing bounded `initialEvidence`, with no series table;
- `maxCycles` remains generic and explicit; Farstax sets 20 rather than relying on the standalone default of 3;
- final permitted `progress` becomes `budget_exhausted` and creates no successor wake;
- explicit in-process cwd/static-context isolation is proven first;
- Option 3 is used instead if isolation requires invasive provider/global-env work;
- no legacy Company execution migration/compatibility layer;
- no new sensor subsystem, scheduler, worker, second poller, generic orchestrator or subagent framework;
- Platform Company execution machinery is deleted after real qualification.

The implementation objective remains subtraction: make bounded autonomous execution a normal Agent Bridge capability, teach agents how to use it intelligently, let domain workspaces learn their own observation tools, and remove the special Platform machinery that compensated for the missing generic capability.