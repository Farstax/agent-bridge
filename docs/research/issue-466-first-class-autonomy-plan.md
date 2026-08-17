# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Promote the autonomous runtime we already built into a first-class capability of the existing interactive Agent Bridge service.

This is **reuse + small composition seams + subtraction**, not a new autonomous system.

Agent Bridge owns the mechanical safety boundaries. The provider agent owns judgement, observation, planning, communication and domain behaviour.

Do not build a Company runtime, Company sensor framework, narrative generator, second scheduler, worker, second provider stack or legacy Company migration in OSS.

## Reuse first

Reuse the existing shipped primitives unless a red test proves a defect.

`src/autonomousGoalRuntime.ts` already owns:

- durable `autonomous_goals` rows;
- atomic goal + initial wake creation;
- bounded prior evidence;
- durable wakes/idempotency through event receipts;
- one ordinary `bridge_runs` Run per cycle;
- `autonomous:<goalId>` execution ownership;
- original prompt + prior evidence + wake reason on each cycle;
- `progress|complete|blocked|cancelled` reconciliation;
- exactly one successor wake while budget remains;
- `budget_exhausted` on final permitted progress;
- restart fail-closed behaviour for claimed provider boundaries;
- ordinary Run cancellation/descendant fencing;
- bounded `CycleReconciledEvent` observer data.

Reuse the existing:

- `BridgeEngine` provider execution path;
- CLI supervisor/process spawning;
- provider configuration, credentials and preference resolution;
- authenticated interactive Telegram poller;
- normal Telegram delivery path;
- workspace-context loader;
- Soul loader;
- shared Skill catalogue/install/verify/native projection;
- event-receipt/idempotency primitives;
- release/install/upgrade machinery.

The standalone autonomous-goal operator may remain a diagnostic/manual tool. Platform production should stop spawning it after qualification.

### Expected new OSS surface

Keep additions narrow:

1. explicit per-engine execution cwd/static-context options if required;
2. one atomic create-if-none-active helper;
3. one thin policy-neutral autonomy controller;
4. one generic max-cycle setting;
5. one provider-neutral `autonomous-work` Skill;
6. existing Skill-install convergence for the new Skill;
7. small Telegram experiment wiring;
8. the smallest bounded owner-input correlation needed for two-way supervised dialogue.

No new schema is expected unless implementation proves existing durable receipt primitives cannot safely represent owner input.

## Shared model: Goal -> Episode -> Cycle -> Run

- **Goal** — persistent domain/business outcome, outside OSS runtime semantics.
- **Episode** — one bounded autonomous attempt toward that goal.
- **Cycle** — one autonomy-control iteration: claim a wake, execute one ordinary Run, reconcile, then terminate or create the next wake.
- **Run** — the existing Agent Bridge provider execution primitive.

The existing `autonomous_goals` row operationally represents one bounded episode. Do not rename schema merely to perfect terminology.

There is no separate cycle goal.

Existing runtime already gives each cycle:

- the frozen episode prompt;
- retained bounded prior evidence;
- current cycle number;
- wake reason.

Do not add another cycle-state model.

## Freeze episode authority at start

An episode is bounded authorized work. Its objective must not drift because workspace files change later.

At `start()`:

1. read bounded non-empty `AUTONOMY.md`;
2. combine any bounded instruction supplied by the currently authorized start policy;
3. persist the exact resulting episode prompt in existing `autonomous_goals.prompt` with the goal/initial-wake transaction;
4. every cycle uses that stored prompt.

After creation, the active episode never re-reads `AUTONOMY.md` to obtain a different objective.

Workspace files remain live working/observation material, but they cannot silently rewrite active episode authority.

`initialEvidence` remains previous **execution evidence** only.

Owner/current-policy correction is instruction, not evidence. If present at episode start, pass it separately as bounded `policyInstruction` and freeze it into the episode prompt.

Keep these concepts distinct:

```text
episode prompt = frozen objective + authorized start-policy instruction
prior evidence = what previous work observed/did
owner input     = current supervised dialogue within existing authority
current reality = what the provider verifies now
```

Owner input during an active episode does not expand the frozen objective or authority. If the requested action exceeds existing authority, the agent must not reinterpret the message as implicit authorization.

## Intelligence boundary: the agent chooses what to observe

The framework must not prescribe a fixed observation pipeline.

Before a material decision, the provider decides what it needs to know and chooses the cheapest reliable permitted source, for example:

- safe authoritative database/report access;
- filesystem/repository/git inspection;
- logs/service/runtime inspection;
- existing CLI/API;
- projected Skills/domain tools;
- web/search capability when external reality matters;
- an existing domain-owned mechanical helper.

Prior evidence is continuity, not automatically current truth.

A new cycle does **not** mean “run all sensors”. It means another opportunity to observe, reason and act toward the frozen objective.

### Mechanical sensors are emergent domain work

If repeated observation is materially cheaper/faster/more reliable to mechanise, the domain agent may create a query/script/report/check/Skill in its own writable workspace.

OSS must not gain:

- Company/domain sensor registry;
- sensor schema;
- mirrored domain-state tables;
- sensor scheduler/poller;
- mandatory context-refresh service;
- Farstax-specific observation APIs;
- a rule that every cycle invokes a particular sensor.

## Owner communication is agent behaviour, not controller narration

The supervised experiment needs the owner to understand meaningful Company progress and be able to question or steer it.

Do **not** implement this as a controller-generated narrative such as a templated “cycle N did X, next Y”. The runtime does not know which decision matters or how it should be explained.

The Company/provider agent authors the communication.

### Smallest initial contract

Extend the autonomous cycle result with one optional bounded agent-authored field:

```ts
interface AutonomousCycleResult {
  status: "progress" | "complete" | "blocked" | "cancelled";
  evidence: string;
  nextWakeReason?: string;
  ownerMessage?: string;
}
```

Semantics:

- `evidence` remains durable execution evidence for runtime continuity;
- `nextWakeReason` remains mechanical successor intent;
- `ownerMessage` is optional human communication authored by the provider;
- Agent Bridge validates/bounds/transports `ownerMessage`; it does not synthesize, summarize or rewrite it;
- no owner message is required merely because a cycle ended.

The `autonomous-work` Skill decides when communication is useful. Typical reasons include:

- a material decision or change of direction;
- meaningful progress or a result the owner should know;
- a surprising discovery or changed understanding;
- material risk/uncertainty;
- a question where owner judgement would help;
- terminal outcome or a useful episode review.

Avoid ceremonial updates, tool-call narration, mechanical cycle summaries and spam.

For the first implementation, **do not build a mid-Run messaging broker**. A cycle boundary is already a durable reasoning checkpoint. If real qualification shows individual cycles are too long for useful supervision, add a later generic provider-side owner-message capability using existing scoped-capability/broker patterns. Do not prebuild it now.

### Telegram delivery

When `ownerMessage` is present after successful cycle reconciliation, the existing interactive process sends the provider-authored text through the existing Telegram delivery path.

`CycleReconciledEvent` may carry the optional bounded `ownerMessage` for this transport. It remains an observation/delivery seam, not a narrative generator.

Delivery must not expose raw provider stdout, hidden reasoning, tool logs or credentials.

There is still one bot token and one Telegram poller.

## Owner questions and steering

Two-way supervision should remain equally small.

The preferred interaction is natural Telegram reply-to semantics:

1. Company agent authors an `ownerMessage`;
2. interactive bot sends it;
3. owner replies to that Company message;
4. the adapter correlates the reply to the one active autonomous episode;
5. the bounded owner text is durably/idempotently recorded as **owner input**, separate from evidence and policy instruction;
6. the next available cycle receives bounded owner input in a distinct prompt section.

If owner input arrives while a cycle Run is already executing, do not interrupt/restart the provider merely to inject it. Make it available to the next cycle. `/autonomy stop` remains the immediate intervention path.

Do not add NLP routing to guess whether arbitrary chat messages are Company steering. Prefer explicit Telegram reply correlation. Add a command fallback only if real Telegram behaviour proves reply correlation insufficient.

The runtime/controller does not interpret owner input. The provider agent decides whether it is:

- a question to answer;
- useful context;
- tactical steering within the frozen objective/authority;
- a request that would exceed current authority and therefore cannot simply be followed.

A genuinely blocking request for new authority may end the episode as `blocked`; a later authorized episode can include the new instruction through the normal start-policy boundary.

Do not add `awaiting_owner`, pause, owner-conversation or approval-series lifecycle states.

### Reuse durable receipt primitives

Prefer the existing event-receipt/idempotency machinery for Telegram owner-input correlation rather than adding an autonomy message table.

The implementation needs only enough durable state to ensure a reply is not lost/duplicated and is consumed into the appropriate next cycle once.

If existing receipt semantics cannot represent this safely without distortion, prove that with a red test before adding any new persistence.

## Teach autonomous work through one OSS Skill

Add:

```text
skills/autonomous-work/SKILL.md
```

Use the existing Skills system. No autonomy-specific Skill loader.

The Skill teaches the provider to:

1. understand `Goal -> Episode -> Cycle -> Run`;
2. treat the current Run as one bounded cycle, not the whole persistent goal;
3. distinguish frozen objective, prior evidence, owner input and current truth;
4. decide dynamically what must be observed before material decisions;
5. prefer authoritative verification where a claim matters;
6. act rather than merely report;
7. use normal provider/Skill/tool capabilities;
8. return the bounded autonomous result contract correctly;
9. provide a concrete `nextWakeReason` for `progress`;
10. communicate intelligently with the owner when something materially useful should be surfaced;
11. write owner messages in its own judgement/voice rather than filling a mechanical template;
12. answer owner questions and incorporate tactical steering when it stays within current authority;
13. never treat conversational steering as implicit expansion of authority;
14. mechanise repeated observations only when justified;
15. understand that budget exhaustion ends the episode, not the persistent domain goal.

The Skill is provider-neutral and contains no Farstax/Company semantics.

## The Skill must actually be installed

Adding a folder under `skills/` is insufficient.

Reuse/update the canonical bundled/default install paths and parity tests so `autonomous-work` converges like other default Skills on:

- fresh install;
- exact-release install;
- existing deployed appliance upgrade;
- Codex native projection;
- Claude native projection;
- Agy native projection;
- `skill-manager verify`.

If guarded rollout currently does not reconcile newly-added default Skills on existing hosts, add the smallest generic reconciliation at the existing install/upgrade/deploy boundary. Do not solve this inside the autonomy controller.

## Workspace contract: immutable authority, writable learning

Representative domain workspace:

```text
company-workspace/
  AGENTS.md
  AUTONOMY.md
  CONTEXT.md          # optional static context only
  mission.md
  goals.md            # optional roadmap/background
  operating-model.md
  constraints.md
  SOUL.md
  skills/
  work/               # durable runtime-writable learned work
```

Canonical control/pack files must be runtime-readable but should not be runtime-replaceable by the autonomous runtime identity.

This includes at least:

- `AUTONOMY.md`;
- `constraints.md`;
- `SOUL.md`;
- canonical Company Skills/instructions.

A runtime user that owns a parent directory can replace/delete root-owned children even if child file mode is read-only. Platform installation must therefore provide a real directory ownership boundary, not only root-owned file modes beneath an agent-owned parent.

`work/` is durable writable Company/domain working state for learned tools, reports, queries and ordinary artifacts. Generic lifecycle/restart/cleanup must not erase it.

## Smallest generic runtime contract

Initial configuration:

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # generic default
```

Farstax explicitly sets `AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=20`.

Do not add autonomy-specific provider, credential, HOME, PATH, Skill path, arbitrary env-overlay or sensor settings.

Rules:

- both required path settings absent -> autonomy disabled;
- exactly one required path set -> startup error;
- autonomy DB canonical path must differ from interactive DB;
- missing/unreadable/empty `AUTONOMY.md` -> fail before start;
- optional context/Soul absence is explicit, never inherited accidentally;
- invalid max-cycle setting -> startup error.

## Policy-neutral mechanical controller

Add one thin `src/autonomyControl.ts` adapter.

Conceptually:

```ts
start({ bot, maxCycles, initialEvidence?, policyInstruction? })
status()
stop()
recordOwnerInput({ idempotencyKey, text, correlation })
```

The controller owns only mechanical concerns:

- autonomy DB lifecycle/isolation;
- prompt freezing;
- atomic single-active creation;
- start/drain/cancel/restart delegation;
- bounded status;
- bounded owner-input persistence/correlation;
- cycle-event plumbing;
- shutdown cleanup.

It does **not** decide:

- what the domain should observe;
- whether a business fact matters;
- what progress deserves telling the owner;
- how to explain a decision;
- how to answer an owner question;
- whether steering is strategically good;
- domain policy or Company semantics.

A useful design test is:

> Could this controller run a research project, software team, personal assistant or Company without knowing which one it is?

If not, behaviour has leaked out of the agent/Skill and into mechanics.

### Atomic start

Add one narrow create-if-none-active helper beside existing `createAutonomousGoal()`.

One SQLite transaction owns active-row check + episode row + initial wake.

- zero active -> create;
- one active -> return existing with `created:false`;
- >1 active -> invariant failure/fail closed;
- no new series identifier or owner-gate persistence.

The prompt passed to it is already frozen.

### Status / stop / restart

Generic status is execution state only: `idle`, `running`, latest terminal bounded status/evidence.

Do not persist `idle` or `awaiting_owner`.

`stop()` delegates to existing cancellation/fencing.

Startup recovery reuses existing unclaimed/claimed wake semantics and stored provider. No timer/poller.

## Owner approval remains temporary experiment policy

Today authenticated `/autonomy approve` is the current policy allowed to call `start()`.

It is not a permanent runtime concept.

Do not persist:

- `owner_approved`;
- `awaiting_owner`;
- owner-gate rows;
- episode-series rows.

A later explicitly-authorized start policy must replace the current human gate without schema/lifecycle migration.

## Provider selection

Reuse normal interactive provider preference/availability resolution.

At start:

1. authenticate through the existing owner boundary;
2. resolve normal available `BotKind`;
3. fail before creation if none launchable;
4. store existing `autonomous_goals.bot`.

Restart uses stored provider. No autonomy provider registry/fallback.

## Option 2 isolation proof

Before owner UX, prove `BridgeEngine` can receive explicit autonomous execution context with narrow options such as:

```ts
executionCwd?: string
workspaceContext?: string | null
```

Required:

- absent options preserve existing behaviour;
- explicit cwd survives invocation/retry/fallback/continuation;
- explicit/empty context cannot bleed from interactive globals;
- existing Soul behaviour remains;
- process cwd/env remain unchanged.

If this needs `process.chdir()`, temporary `process.env`, full env virtualization, another provider-launch abstraction or provider-specific autonomy code, use the minimal dedicated generic OSS service instead.

## Implementation slices

### A — execution-context isolation

Red then green for cwd/context isolation and no global mutation.

### B — policy-neutral controller

Red then green for:

- atomic create-if-none-active;
- frozen prompt bytes;
- later `AUTONOMY.md` edit cannot alter active episode;
- evidence/policy distinction;
- maxCycles;
- status/stop;
- restart/stored provider;
- >1 active fail closed.

### C — `autonomous-work` Skill + deployment convergence

Add Skill through existing machinery; prove fresh/resumed use, Codex/Claude/Agy projection and existing-host upgrade convergence.

### D — intelligent owner dialogue on the existing Telegram surface

Red then green for:

- optional bounded `ownerMessage` in cycle result;
- runtime never fabricates/summarizes owner narrative;
- absent `ownerMessage` sends nothing;
- present `ownerMessage` is delivered unchanged after successful reconciliation;
- no raw stdout/hidden reasoning/tool logs leak;
- owner reply to a Company-authored Telegram message is correlated to the one active episode;
- duplicate Telegram update does not duplicate owner input;
- owner input remains separate from evidence and policy instruction;
- input arriving during cycle N is available to the next cycle, not injected into the running provider;
- next cycle prompt clearly labels bounded owner input;
- tactical steering cannot mechanically expand frozen episode authority;
- `/autonomy stop` remains immediate intervention;
- no second bot/poller, narrative engine, pause lifecycle or owner-conversation state machine.

Do not add a mid-Run owner broker in this slice.

### E — current experiment start/status/stop adapter

Keep `/autonomy approve|status|stop` as current experiment controls using normal provider preference and generic controller.

`/autonomy status` may expose bounded mechanical status; it is not the primary progress narrative. Intelligent progress comes from provider-authored Company messages.

### F — Platform pack/access cutover

Tracked by Platform #352.

### G — Platform execution subtraction

After qualification delete old Platform Company socket/process/operator/briefing/JSONL/lifecycle machinery.

## Real qualification

Prove at minimum:

1. only the existing interactive Telegram process polls the token;
2. one authorized start creates one durable bounded episode;
3. controller contains no owner/domain judgement semantics;
4. episode prompt is frozen at start;
5. canonical pack controls cannot be replaced/deleted by runtime identity;
6. writable `work/` persists across cycles/episodes/upgrades;
7. provider uses normal stored provider/configuration;
8. cwd/context/Soul isolation works without global mutation;
9. `autonomous-work` is installed/projected/verified and actually used;
10. existing deployed-host upgrade converges the new Skill;
11. autonomy DB and interactive DB are distinct;
12. each cycle receives frozen prompt + prior evidence + wake reason + any bounded owner input since the previous cycle;
13. provider decides what current reality requires observation;
14. no predefined Company sensor is required;
15. provider itself authors useful owner communication when material;
16. no mechanical message is emitted merely because a cycle completes;
17. owner can reply to a Company update and that input reaches a later cycle exactly once;
18. provider can answer questions or use tactical steering within current authority;
19. urgent owner stop still fences execution;
20. `progress` creates exactly one successor wake while budget remains;
21. Farstax explicitly uses 20 cycles; cycle-20 progress becomes `budget_exhausted`; no cycle 21;
22. no successor episode starts without current start-policy authorization;
23. no legacy Company execution state is imported.

A useful live proof should show the Company making a real decision, authoring a meaningful Telegram update in its own voice, receiving an owner reply, incorporating that reply in a later cycle, and continuing without Platform orchestration.

## No legacy migration

Start with a fresh current-schema autonomy Bridge DB.

Do not copy/migrate/map/replay/dual-write old Company execution state or build compatibility/reverse migration logic.

## Acceptance

The plan is correct only if:

- existing autonomous lifecycle/provider/Skill primitives are reused;
- `Goal -> Episode -> Cycle -> Run` remains the shared model;
- episode authority is frozen at start;
- evidence, owner input, policy instruction and current truth stay semantically distinct;
- Agent Bridge remains mechanically reliable and domain-neutral;
- the provider/Skill owns observation, judgement and owner communication;
- progress messages are intelligent agent-authored communication, never controller-generated narrative;
- two-way owner dialogue uses the existing interactive bot with minimal durable correlation;
- no mid-Run broker is added without evidence that cycle-boundary dialogue is insufficient;
- `autonomous-work` is guaranteed on fresh/upgraded runtimes through existing Skill machinery;
- canonical controls are immutable to runtime while learned `work/` persists;
- sensors remain optional domain-owned work;
- owner approval remains temporary policy;
- maxCycles remains generic; Farstax sets 20;
- no Company/sensor/scheduler/worker/second-poller/narrative/orchestrator framework is introduced;
- no legacy execution migration is introduced;
- Platform execution machinery is deleted after real qualification.

The objective is subtraction: keep the controller boring and trustworthy; teach the agent how to use that framework intelligently.