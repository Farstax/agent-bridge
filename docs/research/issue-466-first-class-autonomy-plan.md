# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Proceed with **Option 2: promote the existing autonomous-goal runtime into a first-class capability of the existing interactive Agent Bridge service**.

This is primarily composition and subtraction, not a new autonomous system.

Agent Bridge already has the hard lifecycle. The implementation should reuse it, add only the missing first-class composition seams, and teach providers how to operate intelligently inside the loop through one reusable OSS Skill.

Do not build a Company runtime, Company sensor framework, second scheduler, second provider stack, or legacy Company migration in OSS.

## Reuse first

The implementation must start from the primitives already shipped on `main`.

### Reuse unchanged unless a red test proves a defect

`src/autonomousGoalRuntime.ts` already owns:

- durable `autonomous_goals` rows;
- atomic goal + initial wake creation;
- `initialEvidence`;
- durable wakes/idempotency through existing event receipts;
- one ordinary `bridge_runs` Run per cycle;
- `autonomous:<goalId>` execution ownership;
- original prompt + prior bounded evidence + wake reason on each cycle;
- `progress|complete|blocked|cancelled` reconciliation;
- exactly one successor wake while budget remains;
- `budget_exhausted` on the final permitted progress cycle;
- restart fail-closed behavior for claimed provider boundaries;
- ordinary Run cancellation/descendant fencing;
- bounded `CycleReconciledEvent` delivery evidence.

Reuse the existing:

- `BridgeEngine` provider execution path;
- CLI supervisor/process spawning;
- provider configuration and credential resolution;
- authenticated interactive Telegram poller;
- provider preference resolution;
- ordinary delivery path;
- workspace-context loader;
- Soul loader;
- shared Skill catalogue/installer/verification/projection machinery;
- normal release/install/upgrade mechanisms.

The standalone autonomous-goal operator remains useful as a diagnostic/manual tool. Production Company execution should stop depending on Platform spawning it.

### New OSS surface should stay small

The expected new production surface is limited to:

1. explicit per-engine execution cwd/static-context options if Slice A proves they are small;
2. one atomic create-if-none-active helper beside the existing autonomous runtime;
3. one thin policy-neutral autonomy controller;
4. one generic max-cycle configuration value;
5. one provider-neutral `autonomous-work` Skill;
6. small current Telegram experiment wiring;
7. the minimum existing Skill-install convergence needed to guarantee the new Skill is actually present on deployed runtimes.

No new schema is expected.

## Shared model: Goal -> Episode -> Cycle -> Run

Use these terms consistently:

- **Goal** — persistent domain/business outcome. This is outside OSS runtime semantics.
- **Episode** — one bounded autonomous attempt toward that goal.
- **Cycle** — one autonomy-control iteration: claim one durable wake, execute one ordinary Bridge Run, reconcile bounded evidence, then terminate or create the next wake.
- **Run** — the existing Agent Bridge provider execution primitive.

The existing OSS table/type is named `autonomous_goals`; operationally one row is the bounded **episode**. Do not rename schema merely to perfect terminology.

There is no separate cycle goal.

Existing `buildPrompt()` already gives each cycle:

- the frozen episode prompt;
- retained bounded prior evidence;
- current cycle number;
- the wake reason.

Existing reconciliation already has the required loop:

```text
wake
  ↓
cycle
  ↓
ordinary Run
  ↓
reconcile
  ├─ complete / blocked / cancelled → episode terminal
  └─ progress
       ├─ budget remains → exactly one successor wake
       └─ final permitted cycle → budget_exhausted
```

Do not add another cycle-state model.

## Freeze episode authority at start

An episode is bounded authorized work. Its objective/instructions must not drift because workspace files change later.

At `start()`:

1. read bounded non-empty `AUTONOMY.md`;
2. combine any bounded policy instruction supplied by the current authorized start policy;
3. persist the resulting **exact episode prompt** in the existing `autonomous_goals.prompt` field when the goal/wake transaction commits;
4. every cycle uses that stored prompt through the existing runtime.

After creation, the active episode never re-reads `AUTONOMY.md` to discover a different objective.

Workspace files remain live observation/working material, but editing them must not silently rewrite the already-authorized episode prompt.

For domain packs, `AUTONOMY.md` must contain the active persistent outcome/episode mandate needed to authorize the episode. A separate `goals.md` may exist as roadmap/background, but the active episode must not depend solely on a mutable external goal file for its objective.

### Evidence is not policy

`initialEvidence` remains bounded previous **execution evidence** only.

Do not put owner corrections, policy changes, new authority, or new instructions into `initialEvidence`, because the existing runtime labels it as prior evidence.

If the current supervised policy accepts a correction/instruction, pass it as a separately bounded policy instruction at start and freeze it into the stored episode prompt.

This preserves the semantic distinction:

```text
episode prompt = objective + authorized policy instruction
prior evidence  = what previous work observed/did
current reality = whatever the provider verifies now
```

## The intelligence boundary: the agent chooses what to observe

The autonomous framework must not prescribe a fixed observation pipeline.

Before a material decision, the provider determines what it actually needs to know or verify and chooses the cheapest reliable observation method available under its existing authority.

Depending on the work, that may mean:

- querying an authoritative database through a permitted safe boundary;
- inspecting files, repositories or git history;
- reading logs or service/runtime state;
- invoking an existing CLI/API;
- using projected Skills or domain tools;
- using web/search capability when external reality matters;
- using an existing domain-owned mechanical observation tool;
- creating a small reusable query/script/report/check when repeated need justifies mechanisation.

Prior cycle evidence is reasoning continuity. It is not automatically current authoritative truth. The provider decides what needs re-verification.

A new cycle does **not** imply “run all sensors.” It implies another opportunity to observe, reason and act toward the frozen episode objective.

## Mechanical sensors are emergent domain artifacts

If repeated observation is expensive, error-prone, deterministic or time-sensitive enough to benefit from mechanisation, the autonomous agent may create a mechanical observation tool.

Examples:

- saved SQL query;
- shell/Python/TypeScript script;
- deterministic report;
- domain Skill;
- health/check command.

Those are ordinary domain-workspace artifacts.

Agent Bridge OSS must not gain:

- Company/domain sensor registry;
- sensor schema;
- mirrored domain-state tables;
- sensor scheduler/poller;
- mandatory context-refresh service;
- Farstax-specific observation APIs;
- a rule that every cycle invokes a particular sensor.

The rule is:

> **Agent Bridge provides bounded autonomous execution and teaches the operating contract. The autonomous workspace provides intent and access to its world. The agent decides what to observe. Mechanical sensors are domain-owned optimisations that emerge from repeated need.**

## Teach autonomous work through an OSS Skill

Add a provider-neutral bundled Skill:

```text
skills/autonomous-work/SKILL.md
```

Use the existing Skill catalogue/installer/projection system. Do not introduce an autonomy-specific loader.

The Skill teaches:

1. `Goal -> Episode -> Cycle -> Run`;
2. the current Run is one cycle, not the entire persistent goal;
3. original episode prompt, prior evidence and wake reason have different meanings;
4. prior evidence may be stale/incomplete;
5. determine what facts are needed before a material decision;
6. identify authoritative sources and inspect them directly when practical;
7. choose observation methods dynamically instead of following a fixed dashboard;
8. distinguish execution evidence from externally verifiable truth;
9. act toward the episode objective using normal provider/Skill/tool capabilities;
10. return the existing bounded cycle result contract;
11. return a concrete `nextWakeReason` for `progress`;
12. mechanise repeated observations only when reuse/reliability benefit justifies it;
13. keep domain observation tooling in the domain workspace, not OSS;
14. understand that budget exhaustion ends the episode, not the persistent domain goal.

The Skill contains no Farstax/Company/business semantics.

### The Skill must actually be installed

Adding a folder to `skills/` is insufficient.

Current Agent Bridge already has explicit default-skill installation paths and native projections. Implementation must reuse them and make `autonomous-work` converge like the other bundled defaults.

At implementation time inspect the current canonical default lists, including the existing install/upgrade/exact-release owners (currently `scripts/install.sh`, `scripts/upgrade.sh`, and `scripts/agent-bridge-install.py`), and update the existing parity/coverage rather than creating another registry.

Qualification must prove under the real runtime user:

- `autonomous-work` exists in the shared skill store;
- Codex, Claude and Agy native projections resolve to it through the existing mechanism;
- existing `skill-manager verify` succeeds;
- a real autonomous provider invocation can discover/use it;
- an **existing deployed appliance upgraded to the new release** receives/verifies the Skill, not only a fresh install.

If the current guarded release rollout does not converge newly-added default Skills on existing hosts, add the smallest generic Skill reconciliation at the existing install/upgrade/deploy boundary. Do **not** solve this inside `autonomyControl.ts` or provider execution.

## Workspace AGENTS.md is thin orientation

A domain workspace may contain `AGENTS.md`. It does not duplicate the full autonomous-work protocol.

Its role is local orientation and hard domain constraints, for example:

- what the workspace represents;
- where mission/current outcome/constraints live;
- where authoritative systems can be found or how they may be accessed;
- local data/security/authority constraints;
- instruction to use the projected `autonomous-work` Skill;
- confirmation that domain-owned tools may be created locally when useful.

This keeps generic operating-method improvements in OSS while learned domain intelligence remains with the workspace.

## Domain workspace contract

Representative Farstax shape:

```text
company/
  AGENTS.md
  AUTONOMY.md             # active persistent outcome + episode entry mandate
  CONTEXT.md              # optional static managed context only
  mission.md
  goals.md                 # optional roadmap/background; not active episode authority
  operating-model.md
  constraints.md
  SOUL.md
  skills/
  tools/                   # optional, emerges if useful
  reports/                 # optional, emerges if useful
```

Do not require `tools/`, `reports/` or `sensors/`.

Generic runtime meaning is limited to:

- `AUTONOMY.md` — required; read and frozen into the episode prompt at start;
- optional `CONTEXT.md` — static managed workspace context through the existing loader;
- optional `SOUL.md` — existing Soul loader.

Everything else is ordinary workspace content.

The configured workspace is persistent working state across cycles and episodes. Generic autonomy lifecycle/restart/cleanup must not delete arbitrary domain-created artifacts.

## Smallest generic runtime contract

Support one configured autonomous workspace per interactive service instance initially.

Do not build a profile registry or multi-autonomy scheduler before a second real use case exists.

Generic configuration:

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # optional generic default
```

Farstax explicitly sets `AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=20`.

Do not add autonomy-specific provider, credential, Soul path, Skills path, HOME, PATH or arbitrary environment-overlay settings.

Conventions:

- execution cwd = `AGENT_BRIDGE_AUTONOMY_DIR`;
- base entry prompt = `<dir>/AUTONOMY.md`;
- optional static context = `<dir>/CONTEXT.md`;
- optional Soul = `<dir>/SOUL.md`;
- provider = current start policy supplies an already-resolved normal `BotKind`;
- provider config/credentials = normal interactive service/runtime user;
- Skills = existing shared/native projections;
- runtime DB = separate normal Bridge DB;
- cycle budget = resolved generic max-cycle config or explicit start input.

Rules:

- both required path settings absent -> autonomy disabled;
- exactly one required path set -> startup error;
- canonicalize DB paths and fail if autonomy DB equals interactive DB;
- missing/unreadable/empty `AUTONOMY.md` -> fail before start;
- optional static context/Soul missing -> explicit absence; never inherit interactive workspace globals;
- invalid max-cycle setting -> startup error.

## Owner approval is temporary experiment policy

The current one-owner-approval-per-episode behavior is supervised-experiment policy, not generic autonomy mechanics.

The controller is policy-neutral:

```ts
start({
  bot,
  maxCycles,
  initialEvidence?,
  policyInstruction?,
})
status()
stop()
```

`policyInstruction` is optional, bounded and frozen into the episode prompt. It is not stored as evidence.

Today authenticated Telegram `/autonomy approve` is the policy adapter allowed to call `start()`.

Do not persist:

- `owner_approved`;
- `awaiting_owner`;
- owner-gate rows;
- approval/episode-series rows.

A terminal episode does not auto-create a successor while today's experiment policy is enabled, but that rule belongs in the thin adapter/composition layer.

Generic status is execution-oriented (`idle`, `running`, latest terminal). The current Telegram adapter may render idle-after-terminal as “awaiting owner” without persisting that state.

A future explicitly-authorized policy must be able to start a successor without schema/lifecycle replacement.

## Episode continuity without a series model

Within an episode, reuse existing prior-evidence + wake-reason continuity.

Across episodes:

- previous terminal execution evidence may seed `initialEvidence`;
- current owner/policy correction, if any, uses `policyInstruction`;
- the newly-started episode freezes the resulting prompt;
- the provider independently observes whatever current reality matters.

Do not add a series/history table or mirror execution history into Platform.

## Provider selection

Provider selection remains existing interactive policy.

For today's `/autonomy approve` adapter:

1. authenticate through existing owner boundary;
2. resolve the chat's provider through the same preference/availability path as ordinary work;
3. fail before creation if none is launchable;
4. call generic `start()`;
5. persist provider in existing `autonomous_goals.bot`.

On restart:

1. read the active episode row;
2. use stored `goal.bot`;
3. reconstruct the engine from normal provider configuration;
4. if unavailable, fail closed and do not silently switch provider.

Do not add `AGENT_BRIDGE_AUTONOMY_PROVIDER` or autonomous fallback logic.

## Workspace/Soul construction

At start/composition time:

1. resolve workspace root;
2. read bounded non-empty `AUTONOMY.md`;
3. append bounded authorized `policyInstruction` if supplied;
4. freeze the result as the episode prompt before durable creation;
5. load optional static `CONTEXT.md` through existing `loadWorkspaceContext()` with a copied explicit env;
6. otherwise pass explicit empty workspace context;
7. load optional `SOUL.md` through existing Soul functions;
8. pass workspace root as explicit execution cwd.

No `process.chdir()` and no assignment to `process.env`.

Dynamic observation happens inside provider Runs, not composition.

## Runtime module shape

Add one small generic `src/autonomyControl.ts` adapter.

Responsibilities:

1. own dedicated autonomy DB connection lifecycle;
2. validate/canonicalize config and DB isolation;
3. read/freeze entry prompt and load static context/Soul through existing loaders;
4. expose policy-neutral `start/status/stop`;
5. call existing create/drain/cancel primitives;
6. perform one bounded startup recovery pass;
7. surface existing `CycleReconciledEvent` callbacks;
8. close second DB on service shutdown.

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

### Atomic start

Add one narrow helper beside `createAutonomousGoal()`:

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
- more than one active -> invariant failure;
- reuse existing validation/SQL;
- no new table/column/index/repository/series identifier.

The prompt passed to this helper is already frozen.

If created, schedule existing `drainAutonomousGoal()` on a detached promise with explicit error handling. `start()` returns immediately.

### Generic status

Return a bounded execution view:

```ts
{
  state: "idle" | "running";
  current: BoundedAutonomyStatus | null;
  latestTerminal: BoundedAutonomyStatus | null;
}
```

Expose goal ID/status/cycle/maxCycles/bounded evidence only as needed. Do not leak credentials, raw transcript/tool output, or hidden reasoning.

Do not persist `idle` or `awaiting_owner`.

### Stop and restart

`stop()` resolves the one active episode and delegates to existing `cancelAutonomousGoal()`.

Startup recovery:

- zero active -> no action;
- exactly one -> reconstruct engine from stored provider and launch existing drain/recovery once;
- more than one -> fail closed;
- unclaimed wake may continue;
- claimed wake follows existing no-blind-replay behavior;
- terminal episodes do not restart;
- no timer/poller.

## Option 2 safety proof

### Slice A — explicit BridgeEngine execution context

Expected production files:

- `src/engine.ts`;
- `src/workspaceContext.ts` only if a tiny helper is required.

Minimum options:

```ts
executionCwd?: string;
workspaceContext?: string | null;
```

Required semantics:

- absent options preserve existing behavior;
- explicit cwd applies to every provider invocation/retry/model fallback/continuation for that engine;
- explicit workspace context including explicit empty prevents global-context bleed;
- existing Soul behavior remains;
- no full environment virtualization.

Red tests:

- two engines in one process use distinct cwd values;
- retry/fallback retains explicit cwd;
- explicit/empty context cannot bleed from globals;
- process cwd/env remain unchanged.

**Kill-switch:** if this needs `process.chdir()`, temporary `process.env`, full env threading, a new provider-launch abstraction or provider-specific autonomy code, stop Option 2 and use Option 3.

## Implementation slices

### Slice B — policy-neutral controller

Red then green:

- atomic create-if-none-active;
- prompt bytes are frozen at start;
- later `AUTONOMY.md` edit cannot change active episode prompt;
- optional `policyInstruction` is frozen into prompt, not evidence;
- `initialEvidence` remains evidence only;
- explicit maxCycles;
- status/stop;
- restart semantics;
- stored provider;
- >1 active fail closed.

No schema migration.

### Slice C — autonomous-work Skill + deployment convergence

- add `skills/autonomous-work/SKILL.md` using the existing portable Skill contract;
- add it to the existing bundled/default installation path(s), not a new registry;
- keep existing default-list parity tests green;
- prove native projection/verification for Codex, Claude and Agy;
- prove fresh and resumed provider use;
- prove an upgraded existing runtime receives/verifies it;
- no Company semantics and no runtime Skill loader.

### Slice D — current Telegram experiment adapter

Red then green:

- authenticated `/autonomy approve|status|stop`;
- normal provider preference;
- max-cycle config reaches `start()`;
- previous terminal evidence uses `initialEvidence` only;
- optional owner correction uses `policyInstruction` only;
- approve responds immediately;
- status/stop remain usable while draining;
- async bounded delivery;
- no second poller/socket.

## Platform handoff

Platform issue #352 owns the Farstax pack/access/subtraction work.

Platform should:

1. extract/install the existing Company intent/Soul/Skills as a coherent pack;
2. make `AUTONOMY.md` contain the active persistent outcome/episode entry mandate that will be frozen at start;
3. keep `goals.md` optional as roadmap/background rather than mutable active-episode authority;
4. add thin Company `AGENTS.md` pointing to the projected `autonomous-work` Skill;
5. keep authoritative business data in existing stores;
6. expose only safe access plumbing actually required for the agent to inspect its world;
7. not prebuild a Company-state sensor framework;
8. keep learned observation tools as Company-owned workspace artifacts;
9. provision fresh autonomy DB/config with `maxCycles=20`;
10. qualify before deleting old Platform execution machinery.

## Full runtime qualification

The feature is not accepted on unit tests alone.

Prove at minimum:

1. only existing interactive Telegram process polls the token;
2. `/autonomy approve` starts exactly one durable bounded episode;
3. generic controller contains no owner/domain semantics;
4. the episode prompt is frozen at start;
5. changing `AUTONOMY.md` after start does not change the active episode objective;
6. `policyInstruction` is represented as instruction, never prior evidence;
7. provider choice uses existing interactive policy and stored `goal.bot` survives restart;
8. provider runs as normal non-root runtime user;
9. cwd is exactly autonomous workspace;
10. static context/Soul and projected Skills are isolated from interactive work;
11. `autonomous-work` is actually installed, projected, verifiable and consumed;
12. existing deployed-host upgrade path converges the new Skill;
13. autonomy DB and interactive DB are distinct;
14. status/stop work during active Run;
15. restart before claim resumes exactly once;
16. restart after claim never blindly replays provider execution;
17. each continuing cycle receives frozen prompt + retained evidence + wake reason;
18. provider decides what requires observation rather than following a fixed sensor;
19. provider can inspect permitted DB/filesystem/repository/runtime/external sources when relevant;
20. one progress result creates one successor wake while budget remains;
21. Farstax uses explicit 20-cycle budget;
22. cycle 20 progress becomes `budget_exhausted` with no cycle 21;
23. terminal episode does not auto-create successor under today's policy;
24. later authorized episode can receive previous terminal evidence without series table;
25. domain-created workspace artifacts survive later cycles/episodes;
26. no legacy Company execution state is imported;
27. no prebuilt Company sensor is required.

Optional evidence only if naturally useful: the Company creates and later reuses a small mechanical observation tool without any OSS runtime/schema change.

## Platform subtraction after qualification

Expected deletions include:

- Platform Company control socket;
- `companyControl.ts` execution orchestration;
- `companyOperatorProcessBoundary.ts`;
- standalone-operator spawning/wrapping;
- Company-only `runuser/env -i` execution boundary;
- autonomous JSONL translation/polling;
- duplicated Platform episode lifecycle state/config;
- generated Company briefing execution machinery;
- dedicated tests/docs for removed boundaries.

Platform keeps genuine SaaS/control-plane/business facts, deterministic product calculations, Company pack/install path, safe access plumbing and useful read-only business projections.

## Failure/restart/concurrency invariants

- episode row + initial wake commit atomically;
- claimed provider boundaries are never blindly replayed;
- missing stored provider fails closed;
- stop reuses existing Run cancellation/fencing;
- conditional-create is the only new concurrency seam;
- >1 active row is corruption and fails closed;
- autonomous Runs keep existing `surface=autonomous` / `chatKey=autonomous:<goalId>` lane ownership;
- no scheduler is added to compensate for impossible state.

## No legacy execution-data migration

The new path starts with a fresh current-schema Agent Bridge autonomy DB.

Do not:

- copy old Company DB rows;
- import old autonomous goals;
- map old/new episode IDs;
- replay history;
- dual-write lifecycle state;
- build compatibility/reverse-migration logic.

Existing Platform business facts remain authoritative in their current stores. Old Company execution data may remain physically untouched for short-lived forensics/rollback and be removed separately.

## Acceptance

The plan is correct only if all remain true:

- `Goal -> Episode -> Cycle -> Run` is the shared model;
- existing autonomous-goal/wake/Run/cancellation/restart machinery is reused;
- episode prompt/authorized policy instruction is frozen at start;
- previous execution evidence remains semantically separate from policy instruction/current truth;
- Agent Bridge remains generic;
- Agent Bridge teaches autonomous operating behavior through one reusable provider-neutral Skill;
- that Skill is guaranteed to be installed/projected on both fresh and upgraded runtimes through existing Skill machinery;
- workspace `AGENTS.md` stays thin/local;
- provider chooses what to observe and how;
- mechanical sensors are optional domain-owned artifacts;
- no mandatory Company-state sensor exists;
- owner approval is temporary start policy, not runtime schema/lifecycle;
- maxCycles remains generic; Farstax explicitly sets 20;
- explicit cwd/static-context isolation is proven first;
- Option 3 is used instead if isolation requires invasive provider/global-env work;
- no legacy Company execution migration/compatibility layer;
- no new sensor subsystem, scheduler, worker, second poller, generic orchestrator or subagent framework;
- Platform execution machinery is deleted after real qualification.

The implementation objective remains subtraction: expose the autonomous runtime we already built as a normal Agent Bridge capability, teach providers how to use it, let domain workspaces learn their own tools, and delete the special Platform machinery that compensated for the missing first-class surface.
