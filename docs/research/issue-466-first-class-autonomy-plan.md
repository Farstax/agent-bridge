# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: implementation plan only. No production behavior changes in this PR.

## Decision

Promote the autonomous-goal runtime already in Agent Bridge into a first-class capability of the existing interactive service.

This is **reuse + composition + subtraction**, not a new autonomy stack.

Use **Option 2: in-process first-class autonomy** unless the explicit cwd/context isolation proof requires invasive provider/global-environment changes. In that case use the minimal dedicated generic OSS autonomous service from Option 3.

Do not build a Company model, sensor framework, scheduler, worker, second Telegram poller, second provider stack, profile framework, episode-series model or legacy Company migration.

## Reuse what already exists

Keep the current hard runtime authoritative unless a red test proves a defect.

`src/autonomousGoalRuntime.ts` already provides:

- durable `autonomous_goals` state;
- atomic goal + initial wake creation;
- `initialEvidence`;
- durable wakes/idempotency through existing event receipts;
- one ordinary `bridge_runs` Run per cycle;
- `autonomous:<goalId>` lane ownership;
- original episode prompt + prior bounded evidence + wake reason on every cycle;
- `progress|complete|blocked|cancelled` reconciliation;
- one successor wake for `progress` while budget remains;
- `budget_exhausted` on the final permitted progress cycle;
- restart fail-closed behavior for claimed provider boundaries;
- ordinary Run cancellation/descendant fencing;
- bounded `CycleReconciledEvent` output.

Also reuse:

- `BridgeEngine`;
- CLI supervisor/process spawning;
- normal provider configuration, credentials and execution modes;
- interactive provider preference resolution;
- existing authenticated Telegram poller and delivery;
- workspace-context loader;
- Soul loader;
- shared Skill catalogue/install/verify/native projection machinery;
- normal release/install/upgrade mechanisms.

The standalone autonomous-goal operator may remain as a diagnostic/manual CLI. Production Farstax execution stops depending on Platform spawning it.

## Shared model

```text
Persistent Goal
      ↓
Bounded Episode
      ↓
Cycle → ordinary Run → reconcile
  ↑                       │
  └────── progress ───────┘
```

- **Goal** — persistent domain/business outcome; not an OSS runtime entity.
- **Episode** — one bounded autonomous attempt. Existing `autonomous_goals` row represents this operationally.
- **Cycle** — one durable wake + one ordinary Run + reconciliation.
- **Run** — existing Agent Bridge provider execution primitive.

There is no separate cycle goal.

## Freeze episode authority at start

The existing goal row already has the correct durable place for the episode objective: `autonomous_goals.prompt`.

At `start()`:

1. read bounded non-empty `AUTONOMY.md`;
2. append any separately bounded instruction supplied by the currently authorized start policy;
3. freeze those exact bytes into the existing goal prompt when goal + first wake commit;
4. all cycles use that stored prompt.

An active episode never re-reads `AUTONOMY.md` to discover a new objective.

Later workspace edits may change observable working material, but they cannot silently rewrite the already-authorized episode.

For a domain pack, `AUTONOMY.md` therefore contains the **active persistent outcome + episode entry mandate**. `goals.md` may contain roadmap/background but is not mutable active-episode authority.

### Evidence is not policy

Keep semantic roles separate:

```text
episode prompt = objective + authorized policy instruction
prior evidence = what previous execution observed/did
current truth  = what the provider verifies now
```

`initialEvidence` remains bounded previous execution evidence only.

Do not put owner correction, changed authority or new instructions into `initialEvidence`.

If the current start policy supplies a correction, pass it through an optional bounded `policyInstruction`; composition freezes it into the episode prompt.

No schema change is needed.

## Agent-owned observation strategy

Agent Bridge teaches the operating method; it does not prescribe the observations.

Before a material decision, the provider decides what it needs to know or verify and chooses the cheapest reliable permitted source, such as:

- safe database/report/API/CLI access;
- filesystem/repository/git inspection;
- logs or service/runtime inspection;
- projected Skills/domain tools;
- web/search capability when available and relevant;
- an existing domain-owned deterministic helper.

Prior cycle evidence is continuity, not automatically current truth.

A new cycle does not mean “run every sensor.” It means observe what matters, reason, act, reconcile.

## Mechanical sensors emerge in the domain

If repeated observation becomes materially cheaper, faster or more reliable when mechanised, the provider may create a reusable query/script/report/check/Skill.

Those are ordinary domain work products.

OSS must not gain:

- sensor registry/schema;
- mirrored domain-state tables;
- sensor scheduler/poller;
- mandatory context-refresh service;
- Farstax-specific observation APIs;
- a rule requiring a particular sensor each cycle.

## Teach the loop through one OSS Skill

Add:

```text
skills/autonomous-work/SKILL.md
```

Use the existing portable Skill contract and existing shared/native projection system.

The Skill teaches:

- `Goal -> Episode -> Cycle -> Run`;
- frozen episode objective vs prior evidence vs current truth;
- dynamic observation selection;
- authoritative verification when a decision depends on a fact;
- act rather than merely report;
- existing bounded `progress|complete|blocked|cancelled` result semantics;
- concrete `nextWakeReason` for progress;
- budget exhaustion semantics;
- mechanise repeated observations only when justified;
- keep domain tooling in the domain workspace.

It contains no Farstax/Company semantics.

### Reuse Skill installation; guarantee convergence

Adding a folder to `skills/` is not sufficient.

Current Agent Bridge already owns default Skill installation and native projections. Reuse those paths and add `autonomous-work` to the current canonical bundled/default lists rather than creating another registry.

At implementation time inspect the actual current owners, including the equivalents of:

- `scripts/install.sh`;
- `scripts/upgrade.sh`;
- `scripts/agent-bridge-install.py`;
- existing default-list parity/Skill verification tests.

Qualification must prove:

- shared Skill store contains `autonomous-work`;
- Codex, Claude and Agy native projections resolve correctly;
- `skill-manager verify` passes;
- fresh and resumed real provider sessions can use the Skill;
- an **existing deployed runtime upgraded to the new release** receives and verifies it.

If guarded release rollout does not currently converge newly-added default Skills on existing hosts, add the smallest generic reconciliation at the existing install/upgrade/deploy boundary. Do not put Skill installation in the autonomy controller or provider path.

## Domain workspace contract

Representative layout:

```text
company/
  AGENTS.md
  AUTONOMY.md
  CONTEXT.md          # optional static managed context
  mission.md
  goals.md             # optional roadmap/background
  operating-model.md
  constraints.md
  SOUL.md
  skills/              # canonical domain Skills
  work/                # durable runtime-writable Company work
```

`tools/`, `reports/`, learned Skills, saved queries, etc. may emerge under `work/`; no sensor-specific structure is required.

### Authority vs learning filesystem boundary

The runtime must **not require the workspace root/control files to be writable**.

Canonical pack/control files are expected to be installed read-only to the runtime identity:

- `AGENTS.md`;
- `AUTONOMY.md`;
- mission/goals/operating-model/constraints;
- `SOUL.md`;
- canonical `skills/`.

The domain gets a separate persistent writable area such as `work/` for learned tools and ordinary Company artifacts.

Why this matters: file mode on a root-owned file is not enough if the runtime user owns the parent directory; a writable parent can permit replacement/deletion. The owning installer must enforce the directory ownership boundary, not just file modes.

This preserves both properties:

- the agent can learn/build durable tooling;
- the agent cannot silently rewrite its own future episode objective, canonical constraints, Soul or canonical Skills outside normal reviewed/domain authority.

Generic autonomy lifecycle/restart/cleanup must not delete arbitrary files in the writable domain work area.

If a learned artifact should become canonical pack content, promote it through the domain's normal reviewed process.

## Smallest generic runtime contract

Support one configured autonomous workspace per interactive service instance initially.

Generic configuration:

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # optional generic default
```

Farstax explicitly sets `AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=20`.

Do not add autonomy-specific provider, credential, Soul path, Skills path, HOME, PATH or arbitrary env-overlay configuration.

Rules:

- both required path settings absent -> autonomy disabled;
- exactly one required path set -> startup error;
- canonicalize paths and reject autonomy DB == interactive DB;
- missing/unreadable/empty `AUTONOMY.md` -> start fails closed;
- optional context/Soul absence is explicit; do not inherit interactive globals;
- invalid max-cycle setting -> startup error.

## Policy-neutral controller

Add one thin generic `src/autonomyControl.ts` adapter over existing primitives.

Conceptual API:

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

Responsibilities:

- own dedicated autonomy DB connection lifecycle;
- validate config/DB isolation;
- read/freeze episode prompt;
- load static workspace context/Soul through existing loaders;
- create/drain/cancel through existing autonomous runtime;
- perform one bounded startup recovery pass;
- surface bounded cycle events;
- close second DB on service shutdown.

It must not own domain state, sensors, credentials, another worker loop, socket, scheduler, command framework or lifecycle model.

### Atomic start

Add one narrow helper beside `createAutonomousGoal()`:

```ts
createAutonomousGoalIfNoneActive(db, input)
  -> { created: boolean; goal: AutonomousGoal }
```

One SQLite transaction owns active-row check + episode insert + first wake.

- zero active -> create;
- one active -> return existing with `created:false`;
- more than one -> invariant failure;
- no new table/index/series identifier.

The prompt passed to it is already frozen.

### Status/stop/restart

Generic status is execution state only: `idle`, `running`, latest terminal bounded status/evidence.

Do not persist `idle` or `awaiting_owner`.

`stop()` delegates to existing `cancelAutonomousGoal()`.

Startup recovery:

- zero active -> no action;
- one active -> reconstruct engine from stored `goal.bot` and use existing drain/recovery once;
- >1 active -> fail closed;
- claimed wake -> existing no-blind-replay behavior;
- no timer/poller.

## Owner approval is temporary policy

Today's authenticated `/autonomy approve` adapter is the policy currently allowed to call `start()`.

It is not a permanent runtime concept.

Do not persist owner approval/gate/series state. Terminal episode does not auto-start a successor while today's experiment policy is enabled, but this is a thin adapter rule.

A later explicitly-authorized start policy must replace this without schema/lifecycle migration.

## Provider selection

Reuse normal interactive provider preference/availability resolution.

At start:

1. authenticated surface resolves normal available `BotKind`;
2. fail before creation if none launchable;
3. store existing `autonomous_goals.bot`.

Restart uses stored provider. Do not silently switch provider or add an autonomy provider registry/fallback.

## Option 2 isolation proof

Before adding owner UX, prove `BridgeEngine` can receive explicit autonomous execution context with only narrow options such as:

```ts
executionCwd?: string
workspaceContext?: string | null
```

Required:

- absent options preserve existing behavior;
- explicit cwd survives every provider invocation/retry/fallback/continuation;
- explicit/empty workspace context cannot bleed from interactive globals;
- existing Soul behavior remains;
- process cwd/env remain unchanged.

Kill Option 2 and use the minimal generic second service if this requires `process.chdir()`, temporary `process.env`, full env virtualization, another provider-launch abstraction or provider-specific autonomy code.

## Implementation slices

### A — execution-context isolation

Red then green for cwd/context isolation and no process-global mutation.

### B — policy-neutral controller

Red then green for:

- atomic create-if-none-active;
- frozen prompt bytes;
- later `AUTONOMY.md` edit cannot alter active episode;
- `initialEvidence` evidence-only;
- optional `policyInstruction` instruction-only;
- maxCycles;
- status/stop;
- restart/stored provider;
- >1 active fail closed.

No schema migration.

### C — `autonomous-work` Skill + existing deployment convergence

Add Skill; update existing default install paths; preserve parity tests; prove Codex/Claude/Agy projection, fresh/resumed use, and existing-host upgrade convergence.

### D — current Telegram experiment adapter

Red then green for:

- authenticated `/autonomy approve|status|stop`;
- normal provider selection;
- maxCycles reaches `start()`;
- previous terminal evidence uses `initialEvidence`;
- optional correction uses `policyInstruction`;
- immediate approve response;
- status/stop during drain;
- bounded async delivery;
- no second poller/socket.

### E — Platform pack/access cutover

Tracked in Platform #352. Platform extracts the current Company pack, creates the immutable-control/writable-work filesystem boundary, supplies safe authoritative access, provisions fresh autonomy DB/config and qualifies Farstax at 20 cycles.

### F — Platform subtraction

After qualification delete Platform Company execution socket/process/operator/briefing/JSONL/lifecycle machinery.

## Real qualification

Prove at minimum:

1. only existing interactive Telegram process polls the token;
2. one start creates one bounded episode;
3. controller contains no owner/domain semantics;
4. episode objective/policy instruction is frozen at start;
5. later control-file edit cannot alter active episode;
6. canonical pack/control files are not writable/replacable by runtime identity;
7. durable writable `work/` artifacts survive later cycles/episodes;
8. prior evidence and policy instruction stay semantically distinct;
9. provider choice uses existing interactive policy and stored `goal.bot`;
10. provider runs as normal non-root runtime user;
11. cwd/context/Soul isolation works without process-global mutation;
12. `autonomous-work` is installed/projected/verified and used;
13. existing deployed-host upgrade converges the new Skill;
14. autonomy DB and interactive DB are distinct;
15. status/stop work during an active Run;
16. restart before claim resumes once; restart after claim never blindly replays;
17. each continuing cycle receives frozen prompt + prior evidence + wake reason;
18. provider decides what current reality requires observation;
19. no predefined Company sensor is required;
20. `progress` creates one successor while budget remains;
21. Farstax explicitly uses 20 cycles; cycle-20 progress becomes `budget_exhausted`; no cycle 21;
22. no successor episode starts without current start-policy authorization;
23. no legacy Company execution state is imported.

Optional only if naturally useful: Company creates/reuses a mechanical observation helper under writable domain work without OSS runtime/schema change.

## No legacy migration

Start with a fresh current-schema autonomy Bridge DB.

Do not copy/migrate/map/replay/dual-write old Company execution state or build reverse/compatibility migration logic.

## Acceptance

- existing autonomous lifecycle/provider/Skill machinery is reused;
- new OSS surface stays narrow;
- `Goal -> Episode -> Cycle -> Run` is the shared model;
- episode authority is frozen at start;
- evidence, policy instruction and current truth remain distinct;
- `autonomous-work` uses existing Skill machinery and is guaranteed on upgraded hosts;
- immutable canonical pack vs durable writable domain work is explicit;
- provider chooses observations dynamically;
- mechanical sensors are optional domain-owned artifacts;
- owner approval remains temporary policy;
- maxCycles remains generic; Farstax sets 20;
- no Company/sensor/scheduler/worker/orchestrator framework;
- no legacy Company execution migration;
- Platform execution machinery is deleted after real qualification.
