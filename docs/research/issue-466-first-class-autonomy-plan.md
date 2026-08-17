# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Promote the autonomous runtime already in Agent Bridge into a first-class capability of the existing interactive service.

This is **reuse + small composition seams + subtraction**, not a new autonomy stack.

The boundary is deliberate:

- **Agent Bridge/controller owns mechanics:** durability, isolation, concurrency, Run ownership, budgets, restart, cancellation, bounded transport and correlation.
- **Provider agent + Skills/domain workspace own intelligence:** observation, judgement, planning, decisions, communication and domain behaviour.

Do not build a Company runtime, sensor framework, narrative generator, scheduler, worker, second poller, second provider stack, or legacy Company migration in OSS.

## Reuse first

Reuse existing primitives unless a red test proves a defect:

- `autonomous_goals`;
- durable autonomous wakes through `event_receipts`;
- ordinary `bridge_runs`;
- `createAutonomousGoal()` / `runNextAutonomousGoal()` / `drainAutonomousGoal()`;
- frozen prompt + bounded prior evidence + wake-reason continuity;
- existing cycle/max-cycle budget and `budget_exhausted`;
- restart fail-closed behaviour;
- ordinary Run cancellation/descendant fencing;
- `BridgeEngine` and provider execution/configuration;
- existing interactive Telegram poller and delivery;
- workspace-context and Soul loaders;
- shared Skill catalogue/install/verify/native projection;
- existing settings/KV store;
- normal release/install/upgrade machinery.

The standalone autonomous-goal operator may remain diagnostic/manual. Platform production stops spawning it after qualification.

### Expected new OSS surface

Keep additions narrow:

1. explicit per-engine execution cwd/static-context isolation if required;
2. one atomic create-if-none-active helper;
3. one thin policy-neutral autonomy controller;
4. one generic max-cycle setting;
5. one provider-neutral `autonomous-work` Skill;
6. existing Skill-install convergence for the new Skill;
7. optional provider-authored supervisor communication in the cycle result;
8. minimal durable supervisor route/input correlation on the existing interactive surface.

No schema migration is expected.

## Shared model: Goal → Episode → Cycle → Run

- **Goal** — persistent domain/business outcome outside OSS runtime semantics.
- **Episode** — one bounded autonomous attempt toward that goal.
- **Cycle** — claim one durable wake, execute one ordinary Run, reconcile, then terminate or create one successor wake.
- **Run** — existing Agent Bridge provider execution primitive.

The existing `autonomous_goals` row operationally represents one bounded Episode. Do not rename schema merely to perfect terminology.

There is no separate cycle goal and no second cycle-state model.

## Freeze episode authority at start

An Episode is bounded authorized work. Its objective must not drift because workspace files change later.

At generic `start()`:

1. read bounded non-empty `AUTONOMY.md`;
2. combine any separately bounded instruction supplied by the currently authorized start policy;
3. persist the exact resulting prompt in existing `autonomous_goals.prompt` in the same transaction that creates the Episode and initial wake;
4. every cycle uses that stored prompt.

Later edits to `AUTONOMY.md` or other workspace files cannot silently change the active Episode objective.

Keep these concepts separate:

```text
episode prompt      = frozen objective + authorized start-policy instruction
prior evidence      = what prior work observed/did
supervisor input    = supervised dialogue within existing Episode authority
current reality     = what the provider verifies now
```

`initialEvidence` remains previous **execution evidence** only.

Start-time correction/instruction uses separate bounded `policyInstruction` and becomes part of the frozen prompt.

Supervisor input during an active Episode does not mechanically expand the frozen objective or authority.

## Agent chooses what to observe

The framework must not prescribe a fixed observation pipeline.

Before a material decision, the provider determines what it needs to know and chooses the cheapest reliable permitted source, for example:

- safe authoritative database/report access;
- filesystem/repository/git inspection;
- logs/service/runtime state;
- an existing CLI/API;
- projected Skills/domain tools;
- web/search when external reality matters;
- an existing domain-owned helper.

Prior evidence is continuity, not automatically current truth.

A new cycle does **not** mean “run all sensors”. It is another opportunity to observe, reason and act toward the frozen Episode objective.

### Mechanical sensors emerge from repeated need

If repeated observation becomes materially cheaper, faster or more reliable to mechanise, the domain agent may create a query/script/report/check/Skill in its writable domain workspace.

OSS must not gain:

- Company/domain sensor registry;
- sensor schema;
- mirrored domain-state tables;
- sensor scheduler/poller;
- mandatory context-refresh service;
- Farstax-specific observation APIs;
- mandatory per-cycle sensor calls.

## Intelligent supervised communication

The supervised experiment needs useful progress communication and a way for the supervising human to question or steer the work.

The runtime must **not** manufacture a narrative from cycle fields. The provider agent decides what is worth communicating and writes the message itself.

### Optional provider-authored supervisor message

Extend the strict cycle result with one optional bounded field:

```ts
interface AutonomousCycleResult {
  status: "progress" | "complete" | "blocked" | "cancelled";
  evidence: string;
  nextWakeReason?: string;
  supervisorMessage?: string;
}
```

Semantics:

- `evidence` = durable execution evidence for autonomous continuity;
- `nextWakeReason` = mechanical reason for a successor cycle;
- `supervisorMessage` = optional human-facing prose authored by the provider;
- Bridge validates and bounds it, then transports the provider's prose without summarising or templating it;
- absence means no message is emitted merely because a cycle completed.

Use a conservative supervisor-message bound, e.g. <= 3,000 characters. The Skill should teach conversational prose rather than tables/attachments so the initial Telegram path can send one normal text message and retain a concrete Telegram `message_id` for reply correlation.

The `autonomous-work` Skill should teach the provider to communicate when useful, including:

- material decisions or changes of direction;
- meaningful progress/results;
- changed understanding or surprising discoveries;
- material risk/uncertainty;
- a question where supervisor judgement would help;
- terminal outcome/review.

It must also teach the provider **not** to emit ceremonial per-cycle summaries, tool-call narration or mechanical status prose.

### Initial scope: cycle-boundary dialogue

Do **not** build a mid-Run supervisor messaging broker in the first implementation.

A cycle boundary is already a durable reasoning checkpoint. Deliver `supervisorMessage` after successful reconciliation.

There is no inter-cycle grace period or approval delay. `drainAutonomousGoal()` remains free to continue immediately.

If real qualification proves individual cycles are too long for useful supervision, create a later issue for a generic provider-side supervisor capability, potentially reusing the existing scoped capability/broker pattern. Do not prebuild it now.

## Generic supervisor, current owner binding

OSS should use **supervisor** terminology. The current Telegram experiment binds that generic supervisor to the authenticated owner.

Owner approval remains temporary start-policy behaviour. Supervisor transport is not approval state.

## Durable supervisor route without new schema

A supervised Episode must remember where/which supervisor it is bound to across process restart.

Generic `start()` may accept:

```ts
supervisorRoute?: {
  surface: string;
  address: string;
  identity?: string;
  thread?: string;
}
```

The current Telegram adapter supplies:

- `surface = telegram`;
- `address = authenticated chat ID`;
- `identity = authenticated owner user ID`;
- thread ID when applicable.

Persist a bounded supervisor route/correlation record in the existing settings/KV store, namespaced by `goalId`, in the same database transaction as creation of a **new** Episode + initial wake.

The record may also retain a bounded list of recently-sent supervisor Telegram message IDs for that exact Episode, sufficient for reply correlation. Bound the list by the Episode budget / a small hard maximum; do not create an unbounded message history.

Do not add owner/Telegram columns to `autonomous_goals`.

If `start()` finds an already-active Episode, do **not** silently rebind its supervisor route to the caller.

The route record is transport/correlation metadata only. It does not authorize the Episode and does not make owner approval a generic runtime concept.

A future start policy may supply another supervisor surface or no supervisor at all without schema/lifecycle replacement.

## Telegram delivery and reply correlation

The existing Telegram text/entity path can return the first Telegram `message_id`; richer document/table routes may return `null`.

For supervisor messages:

- use/expose the existing normal text-message delivery path;
- do not route through document/rich-layout fallbacks;
- after successful send, append the returned message ID to the bounded correlation record for that exact `goalId`/run/cycle;
- delivery is best-effort and never rolls back already-reconciled autonomous work;
- delivery failure is caught/logged and the Episode continues;
- do not add a durable outbound notification queue or replay old narrative after restart.

A reply correlation is valid only for the active goal that emitted the referenced Telegram message.

## Supervisor questions and steering

Preferred current Telegram flow:

1. provider authors optional `supervisorMessage`;
2. adapter resolves persisted supervisor route and sends one normal text message;
3. adapter records returned Telegram message ID in that Episode's bounded correlation state;
4. the bound authenticated owner replies naturally to the Company-authored message;
5. adapter verifies reply sender/chat/thread against the persisted route and verifies the replied-to message ID belongs to the same currently-active goal;
6. bounded reply becomes one idempotent `supervisor_input` receipt for that goal;
7. the earliest later cycle whose input-claim transaction has not committed receives that input in a separate prompt section;
8. provider decides whether the input is a question, context, tactical steering or a request exceeding current authority.

If the referenced goal is terminal or different from the current active goal, do **not** inject the reply into another Episode. Leave it on the ordinary interactive path/new authorized work.

Input arriving while a Run is already executing is never injected into that running provider. If the next cycle already claimed its inputs, the reply naturally reaches a later cycle.

`/autonomy stop` remains the immediate intervention path.

Do not use NLP to guess whether arbitrary owner messages are Company steering. Prefer explicit Telegram reply correlation. Add a command fallback only if live Telegram qualification proves reply semantics insufficient.

A request that truly requires new authority may cause the provider to return `blocked`; a later authorized Episode can receive new authority/instruction through the normal start-policy boundary.

Do not add `awaiting_owner`, pause, supervisor-conversation or approval-series lifecycle states.

### Narrow Telegram type change

Current `TelegramMessage` does not expose Telegram reply metadata. Add only the narrow `reply_to_message` information needed for message-ID/sender correlation.

Regression tests must prove non-correlated replies continue through the normal interactive path.

## Event receipts are for actual inbound supervisor input

Use `event_receipts` for the real durable/idempotent **inbound** `supervisor_input` lifecycle, because that input must be assigned to exactly one ordinary Run.

Do **not** use pending event receipts as static supervisor-route or outbound-message metadata; those belong in bounded settings/KV correlation state described above. This preserves the existing receipt lifecycle (`received -> run_created -> terminal`) instead of inventing pseudo-pending metadata receipts.

### Fix existing wake assumptions first

Current autonomous wake discovery is too broad for adding another autonomous event kind.

Before creating `supervisor_input` receipts:

- `pendingWake()` explicitly filters `event_kind = AUTONOMOUS_EVENT_KIND` (`goal_wake`);
- `recoverableWake()` explicitly filters the wake kind;
- `claimWakeAndRun()` defensively verifies source + status + wake event kind;
- audit every wake-specific autonomous receipt query/update and remove source-only wake assumptions;
- add regressions proving a `supervisor_input` receipt can never be selected, claimed or recovered as a wake.

Use a distinct event kind such as `supervisor_input`; do not overload `goal_wake`.

### Supervisor-input assignment

Supervisor input is not evidence and must not be consumed before execution assignment.

When a cycle wake is claimed and its ordinary Run is created, use the **same transaction** to associate any currently-pending bounded `supervisor_input` receipts for that goal with that Run (`run_created`) using existing receipt/run correlation semantics.

Build that cycle prompt with a distinct section:

```text
Supervisor input since previous cycle:
...
```

After cycle reconciliation, terminalise the supervisor-input receipts consistently with that Run/cycle outcome.

If the Run becomes ambiguous after the provider boundary, existing fail-closed restart behaviour applies; do not replay the provider merely to re-consume supervisor input.

When an Episode becomes terminal, retire/cancel any still-unassigned pending `supervisor_input` receipts for that goal so they do not remain indefinitely pending and cannot leak into another Episode.

This gives durable at-most-one-cycle assignment without a new message table.

If existing receipt status semantics cannot support this safely, demonstrate the conflict with a red test before adding persistence.

## Teach autonomous work through one OSS Skill

Add:

```text
skills/autonomous-work/SKILL.md
```

Use the existing Skills system. Do not add an autonomy-specific loader.

Teach the provider to:

1. understand `Goal -> Episode -> Cycle -> Run`;
2. distinguish frozen objective, prior evidence, supervisor input and current truth;
3. determine dynamically what needs observing;
4. verify material claims against authoritative sources when appropriate;
5. act rather than merely report;
6. use normal provider/Skill/tool capabilities;
7. return the strict bounded cycle result;
8. provide concrete `nextWakeReason` for `progress`;
9. maintain useful supervisor awareness without ceremonial reporting;
10. write supervisor messages in its own judgement/voice;
11. answer questions/use tactical steering when within current authority;
12. never treat conversational input as implicit expansion of authority;
13. mechanise repeated observations only when justified;
14. understand budget exhaustion ends this Episode, not the persistent domain goal.

The Skill is provider-neutral and contains no Farstax/Company semantics.

## Skill deployment must converge

Adding a folder is insufficient.

Reuse/update existing default bundled Skill install/parity paths so `autonomous-work` is installed/projected/verified on:

- fresh install;
- exact-release install;
- existing deployed appliance upgrade;
- Codex;
- Claude;
- Agy.

If guarded rollout does not currently reconcile newly-added defaults on existing hosts, add the smallest generic Skill reconciliation at the existing install/upgrade/deploy boundary. Do not put it in the autonomy controller.

## Workspace: immutable authority, writable learning

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

Canonical controls are runtime-readable but not runtime-replaceable. Protect at least `AUTONOMY.md`, constraints, Soul and canonical Skills/instructions.

A runtime-writable parent directory can replace root-owned children regardless of child file mode, so Platform must provide a real directory ownership boundary.

`work/` is durable runtime-writable learned work. Generic lifecycle/restart/cleanup must not erase it.

## Generic runtime configuration

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # generic default
```

Farstax explicitly sets 20.

Do not add autonomy-specific provider, credentials, HOME/PATH, Skills path, arbitrary env overlay or sensor settings.

## Policy-neutral mechanical controller

Conceptually:

```ts
start({
  bot,
  maxCycles,
  initialEvidence?,
  policyInstruction?,
  supervisorRoute?,
})
status()
stop()
recordSupervisorInput(...)
```

Controller responsibilities are mechanical only:

- autonomy DB lifecycle/isolation;
- prompt freezing;
- atomic single-active Episode creation;
- durable bounded supervisor route/message-ID correlation;
- start/drain/cancel/restart delegation;
- bounded status;
- supervisor-input receipt assignment;
- cycle-event/delivery plumbing;
- shutdown cleanup.

It does **not** decide what matters, what to observe, what deserves communication, how to explain a decision, how to answer a question or what tactical choice to make.

Design test:

> Could this controller run a research project, software team, personal assistant or Company without knowing which one it is?

If not, behaviour has leaked from the agent/Skill into mechanics.

### Atomic start

Add one narrow create-if-none-active helper beside existing creation.

One transaction owns:

- active-row check;
- new Episode row;
- initial wake;
- optional supervisor route/correlation setting for that newly-created goal.

Zero active -> create. One active -> return existing without rebinding. More than one -> fail closed.

### Status / stop / restart

Generic status is execution state only (`idle`, `running`, latest terminal bounded view). Do not persist `idle` or `awaiting_owner`.

`stop()` delegates to existing cancellation/fencing.

Startup recovery uses existing wake/provider semantics plus persisted supervisor route. No timer/poller.

## Owner approval remains temporary adapter policy

Current authenticated `/autonomy approve` is today's policy allowed to call generic `start()` and supplies the current Telegram supervisor route.

Supervisor route is transport metadata, not approval state.

Do not persist owner approval/gate/episode-series state. A future authorized start policy can change without schema/lifecycle migration.

## Provider selection

Reuse normal interactive provider preference/availability resolution. Fail before creation if none launchable; store existing `autonomous_goals.bot`; restart uses stored provider. Do not add an autonomy provider registry/fallback.

## Option 2 execution-context proof

Before supervisor UX, prove `BridgeEngine` can receive explicit autonomous cwd/static context with narrow options while preserving existing defaults, retries/fallback/continuations and without process-global cwd/env mutation.

If safe isolation requires `process.chdir()`, temporary `process.env`, full env virtualization, another provider-launch abstraction or provider-specific autonomy code, use the minimal dedicated generic OSS service instead.

## Implementation slices

### A — execution-context isolation

Red/green explicit cwd/context isolation and no global mutation.

### B — core controller

Red/green:

- atomic create-if-none-active;
- frozen prompt bytes;
- evidence-vs-policy separation;
- bounded supervisor route persisted atomically for new Episode;
- existing active Episode cannot be rebound;
- maxCycles;
- status/stop;
- restart/stored provider/route;
- >1 active fails closed.

### C — `autonomous-work` Skill + deployment convergence

Add Skill through existing machinery. Prove provider use and fresh/upgraded Codex/Claude/Agy projection/verification.

### D — supervised dialogue on existing Telegram

Red/green:

- strict cycle parser accepts optional bounded `supervisorMessage` and rejects unknown/oversized fields;
- supervisor message fits one normal text delivery;
- absent field sends nothing;
- provided prose is delivered without narrative rewriting;
- text delivery exposes Telegram `message_id`;
- delivery failure cannot alter reconciled Episode state;
- supervisor route survives restart;
- sent message IDs are retained only in bounded per-goal correlation state;
- Telegram type/parser exposes narrow reply metadata;
- ordinary non-correlated replies stay ordinary interactive chat;
- stale/terminal/different-goal reply never steers current Episode;
- wake-specific receipt queries/claim explicitly filter `goal_wake`;
- `supervisor_input` receipt never masquerades as a wake;
- duplicate Telegram update does not duplicate input;
- cycle claim atomically assigns pending supervisor input to that Run;
- prompt distinguishes supervisor input from evidence;
- input arriving after claim affects a later cycle, never the running provider;
- terminal Episode retires any unassigned supervisor input for that goal;
- no inter-cycle wait;
- tactical steering cannot mechanically expand frozen authority;
- `/autonomy stop` immediately intervenes;
- no second bot/poller, narrative engine, pause lifecycle, outbox or mid-Run broker.

### E — current Telegram experiment adapter

Keep `/autonomy approve|status|stop`.

Mechanical `/autonomy status` is not the primary progress narrative. Intelligent progress comes from provider-authored supervisor messages.

### F — Platform pack/access cutover

Tracked by Platform #352.

### G — Platform execution subtraction

After qualification delete old Platform Company execution/narrative machinery.

## Real qualification

Prove at minimum:

1. one existing interactive Telegram poller/token;
2. one authorized start creates one durable bounded Episode plus durable supervisor route;
3. restart preserves provider and supervisor route;
4. active Episode cannot be rebound by another caller;
5. prompt/authority frozen at start;
6. canonical controls immutable and `work/` durable;
7. provider/cwd/context/Soul/Skills use existing safe paths;
8. `autonomous-work` converges on an upgraded deployed host;
9. autonomy DB remains distinct from interactive DB;
10. each cycle receives frozen prompt + prior evidence + wake reason + supervisor input assigned to that cycle;
11. provider chooses observations dynamically and no predefined sensor is required;
12. provider itself authors a useful supervisor message when material;
13. no mechanical message is emitted solely because a cycle ends;
14. message is one normal Telegram text and its ID is correlated to the exact goal;
15. owner replies through the same bot and unrelated chat remains normal;
16. reply reaches one later cycle exactly once and never masquerades as a wake;
17. reply to stale/terminal Episode cannot steer a newer Episode;
18. no inter-cycle pause; reply affects earliest later unclaimed cycle;
19. urgent stop fences execution;
20. terminal Episode retires late unassigned supervisor input;
21. `progress` creates exactly one successor while budget remains;
22. Farstax uses 20 cycles; cycle-20 progress -> `budget_exhausted`; no cycle 21;
23. no successor Episode without current start-policy authorization;
24. no legacy Company execution state is imported.

Live proof should show a real Company decision, intelligent provider-authored Telegram update, owner reply, later-cycle incorporation and restart-safe supervisor routing with no Platform orchestration.

## No legacy migration

Start with a fresh current-schema autonomy DB.

Do not copy, map, replay, dual-write or reverse-migrate old Company execution state.

## Acceptance

The plan is correct only if:

- existing autonomous lifecycle/provider/Skill primitives are reused;
- `Goal -> Episode -> Cycle -> Run` remains the model;
- Episode authority is frozen at start;
- evidence, supervisor input, policy instruction and current truth remain distinct;
- controller stays boring, mechanical and domain-neutral;
- provider/Skill owns observation, judgement and communication;
- progress communication is intelligent provider-authored prose, never generated narrative;
- current owner uses existing Telegram bot as the generic supervisor surface;
- durable supervisor route survives restart without embedding owner approval;
- existing active Episode cannot be silently rebound;
- stale replies cannot steer another Episode;
- settings/KV owns bounded route/message-ID correlation; event receipts own actual inbound supervisor-input lifecycle;
- wake queries cannot confuse supervisor input for a wake;
- no inter-cycle wait, outbox or mid-Run broker without qualification evidence;
- Skill converges on fresh/upgraded runtimes;
- canonical controls are immutable to runtime and learned `work/` is durable;
- sensors remain optional domain work;
- owner approval remains temporary start policy;
- maxCycles remains generic; Farstax sets 20;
- no Company/sensor/narrative/scheduler/worker/second-poller/orchestrator framework;
- no legacy execution migration;
- Platform execution/narrative machinery is deleted after qualification.

The objective is subtraction: keep the controller boring and trustworthy; teach the agent how to use the framework intelligently.