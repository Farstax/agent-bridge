# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Promote the autonomous runtime we already built into a first-class capability of the existing interactive Agent Bridge service.

This is **reuse + small composition seams + subtraction**, not a new autonomous system.

The architectural split is:

- **Agent Bridge/controller:** mechanical durability, isolation, concurrency, budgets, restart, cancellation, bounded transport.
- **Provider agent + Skills/domain workspace:** observation, judgement, planning, decisions, communication and domain behaviour.

Do not build a Company runtime, sensor framework, narrative generator, second scheduler/worker/provider stack, or legacy Company migration in OSS.

## Reuse first

Reuse existing autonomous runtime primitives unless a red test proves a defect:

- `autonomous_goals`;
- durable event receipts/wakes;
- ordinary `bridge_runs`;
- `createAutonomousGoal()` / `runNextAutonomousGoal()` / `drainAutonomousGoal()`;
- original prompt + prior evidence + wake-reason cycle continuity;
- cycle/max-cycle budget and `budget_exhausted`;
- restart fail-closed behaviour;
- ordinary Run cancellation/descendant fencing;
- `BridgeEngine` and provider execution/configuration;
- authenticated interactive Telegram poller/delivery;
- workspace-context and Soul loaders;
- shared Skill catalogue/install/verify/native projection;
- release/install/upgrade machinery.

The standalone autonomous-goal operator may remain diagnostic/manual. Platform production stops spawning it after qualification.

### Expected new OSS surface

Keep additions narrow:

1. explicit per-engine cwd/static-context isolation if required;
2. atomic create-if-none-active helper;
3. thin policy-neutral autonomy controller;
4. generic max-cycle config;
5. provider-neutral `autonomous-work` Skill;
6. existing Skill-install convergence for that Skill;
7. optional agent-authored supervisor message in the cycle result;
8. minimal durable supervisor-input/reply correlation on the existing interactive surface.

No new persistence table is expected if existing event receipts can represent the dialogue correlation cleanly.

## Shared model: Goal -> Episode -> Cycle -> Run

- **Goal** — persistent domain/business outcome outside OSS runtime semantics.
- **Episode** — one bounded autonomous attempt.
- **Cycle** — claim one wake, execute one ordinary Run, reconcile, then terminate or create one successor wake.
- **Run** — existing Agent Bridge provider execution.

The existing `autonomous_goals` row operationally represents one bounded episode. Do not rename schema merely to perfect terminology.

There is no separate cycle goal and no second cycle-state model.

## Freeze episode authority at start

At generic `start()`:

1. read bounded non-empty `AUTONOMY.md`;
2. combine any separately bounded instruction supplied by the currently authorized start policy;
3. persist the exact resulting episode prompt in existing `autonomous_goals.prompt` with the goal/initial-wake transaction;
4. every cycle uses that stored prompt.

Later workspace edits cannot silently rewrite an active episode objective.

Keep semantically separate:

```text
episode prompt      = frozen objective + authorized start-policy instruction
prior evidence      = what prior work observed/did
supervisor input    = current supervised dialogue within existing authority
current reality     = what the provider verifies now
```

`initialEvidence` is previous execution evidence only. Start-time correction/instruction uses separate bounded `policyInstruction` and becomes part of the frozen prompt.

Supervisor input during an active episode does not mechanically expand the frozen objective/authority.

## Intelligence boundary: agent chooses observations

The provider decides what it needs to know before a material decision and chooses the cheapest reliable permitted source, such as:

- safe authoritative DB/report access;
- filesystem/repository/git;
- logs/service/runtime state;
- existing CLI/API;
- projected Skills/domain tools;
- web/search when external reality matters;
- existing domain-owned helpers.

Prior evidence is continuity, not automatically current truth.

A new cycle does **not** mean “run all sensors”. It is another opportunity to observe, reason and act.

### Mechanical sensors are emergent domain work

If repeated observation is materially cheaper/faster/more reliable to mechanise, the domain agent may create a query/script/report/check/Skill in its writable workspace.

OSS must not gain a Company/domain sensor registry, sensor schema, mirrored domain-state tables, sensor scheduler/poller, mandatory refresh service, Farstax-specific observation API, or mandatory per-cycle sensor call.

## Intelligent supervised communication

The supervised experiment needs useful progress communication and a way for the supervising human to question/steer the work.

The runtime must **not** generate a narrative from cycle fields. It cannot know which decision matters or how to explain it.

The provider agent authors the communication.

### Optional agent-authored supervisor message

Extend the strict cycle-result contract with one optional bounded field:

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
- `nextWakeReason` = mechanical reason for another cycle;
- `supervisorMessage` = optional human-facing text written by the provider;
- Bridge validates/bounds/transports it without rewriting its prose;
- Bridge never synthesizes, summarizes or templates it;
- absence means no message is sent merely because a cycle completed.

Use a separate conservative text bound (for example <= 3,000 characters) so the initial Telegram implementation always sends one normal text message and receives a concrete Telegram `message_id` for reply correlation. The autonomous-work Skill should teach conversational prose rather than tables/attachments for this field.

Current Telegram experiment binds the generic **supervisor** to the authenticated owner.

The `autonomous-work` Skill teaches when a message is worth sending: material decisions, changed direction, meaningful progress, changed understanding, risk/uncertainty, useful questions, and terminal review. It also teaches not to emit ceremonial cycle summaries or tool-call narration.

### Initial scope: cycle-boundary dialogue

Do **not** build a mid-Run messaging broker in the first implementation.

A cycle boundary is already a durable reasoning checkpoint. Deliver `supervisorMessage` after successful reconciliation.

If real qualification shows individual cycles are too long for useful supervision, a later issue may add a generic provider-side supervisor-message capability using existing scoped-capability/broker patterns. Do not prebuild it now.

`CycleReconciledEvent` may carry optional bounded `supervisorMessage` for delivery. It remains transport/observation data, not a narrative generator. Never expose raw stdout, hidden reasoning, tool logs or credentials.

### Reuse text delivery and retain reply identity

The existing Telegram delivery layer already has a normal text/entity path that returns the first Telegram `message_id`; richer document/table routes may return `null`.

Supervisor messages need reply correlation, so use/expose the existing **text message** delivery path rather than routing supervisor updates through document/rich-layout fallbacks.

Do not build a durable outbound notification queue in this slice. Supervisor narrative is best-effort transport and must never roll back already-reconciled autonomous work. Delivery errors are caught/logged by the adapter and do not affect episode state.

After a successful send, record the bounded correlation needed to recognize a reply: active goal/run/cycle + Telegram message ID. Prefer existing receipt/idempotency storage rather than a new conversation model. No automatic replay of a supervisor message after process restart merely to guarantee narration.

## Supervisor questions and steering

Use the existing interactive bot. Do not add a second bot/poller.

Preferred current Telegram flow:

1. provider authors optional `supervisorMessage`;
2. interactive adapter sends one normal text message and records its Telegram `message_id` correlation;
3. owner replies naturally to that Company-authored Telegram message;
4. adapter correlates the reply to the active episode;
5. bounded reply is durably/idempotently recorded as generic `supervisor_input`;
6. the earliest later cycle whose input-claim transaction has not yet committed receives it in a clearly separate prompt section;
7. provider decides whether it is a question, context, tactical steering, or a request that exceeds current authority.

There is **no inter-cycle grace period or approval wait**. `drainAutonomousGoal()` remains free to continue. If a reply arrives after cycle N+1 has already claimed its inputs, it naturally reaches a later cycle. `/autonomy stop` remains immediate intervention.

Input is never injected into an already-running provider process.

Do not use NLP to guess whether arbitrary owner chat is steering. Prefer explicit Telegram reply correlation. Add a command fallback only if live Telegram qualification proves reply semantics insufficient.

A genuinely blocking request for new authority may end the episode as `blocked`; a later authorized episode can receive the new instruction through the normal start-policy boundary.

Do not add `awaiting_owner`, pause, supervisor-conversation or approval-series lifecycle states.

### Telegram type seam

Current `TelegramMessage` does not expose Telegram's replied-message field. Add only the narrow reply metadata required for correlation (for example `reply_to_message`/message ID and text/sender information needed by the adapter). Do not broaden Telegram payload modelling beyond the real need.

Regression tests must prove ordinary interactive replies that are not replies to a correlated supervisor message continue through the normal interactive path.

## Reuse event receipts correctly for supervisor dialogue

The existing `event_receipts` table is already the generic durable/idempotent ingress/correlation primitive and is the preferred storage seam.

However current autonomous wake discovery/claim logic assumes autonomous receipts are wakes too broadly. Before adding another autonomous event kind, tighten that invariant.

Required repair:

- `pendingWake()` explicitly filters `event_kind = AUTONOMOUS_EVENT_KIND` (`goal_wake`);
- `recoverableWake()` explicitly filters `event_kind = AUTONOMOUS_EVENT_KIND`;
- `claimWakeAndRun()` defensively verifies the claimed receipt is the `goal_wake` kind as well as the autonomous source/status;
- audit other autonomous receipt queries/updates and make any wake-specific path filter the wake event kind rather than source alone;
- add regressions proving `supervisor_input` and supervisor-message correlation receipts are never selected/claimed/recovered as wakes.

Define distinct generic event kinds for supervisor input/correlation rather than overloading `goal_wake`.

### Input claim semantics

Supervisor input must not be appended to evidence or silently consumed before execution.

When a cycle wake is claimed and its ordinary Run is created, atomically associate any currently pending bounded supervisor-input receipts for that goal with the same cycle Run using existing receipt status/run correlation where practical.

Build that cycle prompt from those claimed inputs in a distinct `Supervisor input since previous cycle:` section.

After successful cycle reconciliation, mark associated input receipts consumed/completed. If that Run becomes ambiguous at the provider boundary, existing fail-closed episode/restart behaviour applies; do not replay the provider merely to re-consume input.

This gives durable at-most-one-cycle assignment without a new message table.

If existing receipt status semantics cannot support this safely, demonstrate the conflict with a red test before adding new persistence.

## Teach autonomous work through one OSS Skill

Add:

```text
skills/autonomous-work/SKILL.md
```

Use the existing Skill system. No autonomy-specific loader.

Teach the provider to:

1. understand `Goal -> Episode -> Cycle -> Run`;
2. distinguish frozen objective, prior evidence, supervisor input and current truth;
3. dynamically decide what needs observing;
4. verify material claims against authoritative sources where appropriate;
5. act rather than merely report;
6. use normal provider/Skill/tool capabilities;
7. return the strict bounded cycle-result contract;
8. provide concrete `nextWakeReason` for `progress`;
9. maintain useful supervisor awareness without ceremonial reporting;
10. write supervisor messages in its own judgement/voice, not fill a template;
11. answer questions/use tactical steering when within current authority;
12. never treat ordinary conversational input as implicit authority expansion;
13. mechanise repeated observations only when justified;
14. understand budget exhaustion ends this episode, not the persistent domain goal.

The Skill is provider-neutral and contains no Farstax/Company semantics.

## Skill deployment must converge

Adding `skills/autonomous-work/` alone is insufficient.

Reuse/update existing bundled/default Skill install paths/parity tests so the Skill is installed/projected/verified on fresh install, exact-release install, existing deployed appliance upgrade, Codex, Claude and Agy.

If guarded rollout does not currently reconcile newly-added defaults on existing hosts, add the smallest generic reconciliation at the existing install/upgrade/deploy boundary. Do not solve this inside autonomy control/provider execution.

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

A runtime user that owns a parent directory can replace/delete root-owned children despite child file modes; Platform must provide a real directory ownership boundary.

`work/` is persistent learned work. Generic lifecycle/restart/cleanup must not erase it.

## Smallest generic runtime/config

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # generic default
```

Farstax explicitly sets 20.

Do not add autonomy-specific provider, credential, HOME, PATH, Skills path, arbitrary env-overlay or sensor settings.

## Policy-neutral mechanical controller

Conceptually:

```ts
start({ bot, maxCycles, initialEvidence?, policyInstruction? })
status()
stop()
recordSupervisorInput({ idempotencyKey, text, correlation })
```

Controller responsibilities are mechanical only:

- autonomy DB lifecycle/isolation;
- prompt freezing;
- atomic single-active creation;
- start/drain/cancel/restart delegation;
- bounded status;
- bounded supervisor-input/correlation persistence;
- cycle-event/delivery plumbing;
- shutdown cleanup.

It does **not** decide what matters, what to observe, what progress deserves communication, how to explain a decision, how to answer a question, or what tactical choice to make.

Design test:

> Could this controller run a research project, software team, personal assistant or Company without knowing which one it is?

If not, behaviour has leaked from agent/Skill into mechanics.

### Atomic start

Add one narrow create-if-none-active helper beside `createAutonomousGoal()`.

One transaction owns active-row check + episode insert + initial wake. Zero active creates; one returns existing; >1 fails closed. No owner gate/series identifier.

### Status/stop/restart

Generic status is execution state only (`idle`, `running`, latest terminal bounded view). Do not persist `idle` or `awaiting_owner`.

`stop()` delegates to existing cancellation/fencing.

Startup recovery uses existing unclaimed/claimed wake semantics and stored provider. No timer/poller.

## Owner approval remains temporary adapter policy

Current authenticated `/autonomy approve` is the current policy allowed to call generic `start()`.

Do not persist owner approval/gate/series state. A future authorized start policy must replace it without schema/lifecycle migration.

Generic supervisor dialogue is independent of which start policy authorized the episode.

## Provider selection

Reuse normal interactive provider preference/availability. Fail before creation if none launchable; store existing `autonomous_goals.bot`; restart uses stored provider. No autonomy provider registry/fallback.

## Option 2 execution-context proof

Before supervisor UX, prove `BridgeEngine` can receive explicit autonomous cwd/static-context with narrow options while preserving current defaults, retries/fallback/continuations and no process-global cwd/env mutation.

If safe isolation requires `process.chdir()`, temporary `process.env`, full env virtualization, another provider-launch abstraction or provider-specific autonomy code, use the minimal dedicated generic OSS service instead.

## Implementation slices

### A — execution-context isolation

Red/green explicit cwd/context and no global mutation.

### B — core controller

Red/green atomic start, frozen prompt, evidence-vs-policy, maxCycles, status/stop, restart/stored provider, >1 active fail closed.

### C — `autonomous-work` Skill + deployment convergence

Add Skill through existing machinery; prove provider use and fresh/upgraded projection.

### D — supervised dialogue on existing Telegram

Red/green:

- strict parser accepts optional bounded `supervisorMessage` and rejects unknown/oversized fields;
- supervisor message stays within one text-message delivery bound;
- no message is generated when field absent;
- provided message is delivered without prose rewriting after successful reconciliation;
- text delivery returns Telegram `message_id` for correlation;
- delivery failure cannot alter reconciled episode state;
- Telegram type/parser exposes only required reply metadata;
- ordinary non-correlated replies remain ordinary interactive chat;
- wake-specific receipt queries/claim explicitly filter `goal_wake` event kind;
- supervisor receipts never masquerade as wakes;
- reply correlation creates one idempotent bounded supervisor input;
- duplicate Telegram update does not duplicate input;
- cycle claim atomically associates pending supervisor input with that Run;
- next cycle prompt labels supervisor input distinctly from prior evidence;
- input is consumed only with reconciliation/fail-closed Run semantics;
- input arriving after a cycle input-claim transaction affects a later cycle, never the running provider;
- tactical steering cannot mechanically expand frozen authority;
- `/autonomy stop` immediately intervenes;
- no second bot/poller, narrative engine, pause lifecycle, inter-cycle wait or mid-Run broker.

### E — current Telegram start/status/stop adapter

Keep `/autonomy approve|status|stop`. Mechanical `/autonomy status` is not the primary progress narrative; intelligent progress comes from provider-authored supervisor messages.

### F — Platform pack/access cutover

Tracked by Platform #352.

### G — Platform execution subtraction

After qualification delete old Platform Company execution/narrative machinery.

## Real qualification

Prove at minimum:

1. one existing interactive Telegram poller/token;
2. one authorized start creates one durable bounded episode;
3. controller remains domain/judgement-neutral;
4. prompt/authority frozen at start;
5. canonical controls immutable to runtime and `work/` durable;
6. provider/cwd/context/Soul/Skills use existing safe paths;
7. `autonomous-work` installed/projected/verified including upgraded host;
8. autonomous DB distinct from interactive DB;
9. each cycle receives frozen prompt + prior evidence + wake reason + supervisor input assigned to that cycle;
10. provider chooses observations dynamically; no predefined sensor;
11. provider itself authors a useful supervisor message when material;
12. no mechanical message solely because a cycle ends;
13. message is delivered as one normal Telegram text message and correlated by returned message ID;
14. owner replies through the same bot and ordinary unrelated chat still works normally;
15. reply reaches one later cycle exactly once and never masquerades as a wake;
16. Company answers/uses tactical steering within current authority;
17. no inter-cycle pause is added; reply affects the earliest later unclaimed cycle;
18. urgent stop fences execution;
19. `progress` creates exactly one successor wake while budget remains;
20. Farstax uses 20 cycles; cycle-20 progress -> `budget_exhausted`; no cycle 21;
21. no successor episode without current start-policy authorization;
22. no legacy Company execution state imported.

Live proof should show a real Company decision, an intelligent agent-authored Telegram update, an owner reply, and later-cycle incorporation with no Platform orchestration.

## No legacy migration

Start with a fresh current-schema autonomy DB. No copying/mapping/replay/dual-write/reverse migration of old Company execution state.

## Acceptance

- existing autonomous lifecycle/provider/Skill primitives are reused;
- `Goal -> Episode -> Cycle -> Run` remains the model;
- authority is frozen at start;
- evidence, supervisor input, policy instruction and current truth stay distinct;
- controller remains boring, mechanical and domain-neutral;
- provider/Skill owns observation, judgement and communication;
- supervised messages are intelligent agent-authored content, never generated narrative;
- current owner uses the existing Telegram bot as the generic supervisor surface;
- Telegram reply identity is supported explicitly and ordinary chat remains unaffected;
- event-kind filtering prevents supervisor/correlation receipts from becoming false wakes;
- no inter-cycle wait or mid-Run broker without qualification evidence;
- Skill converges on fresh/upgraded runtimes;
- canonical controls immutable, learned `work/` durable;
- sensors remain optional domain work;
- owner approval remains temporary start policy;
- maxCycles generic, Farstax sets 20;
- no Company/sensor/narrative/scheduler/worker/second-poller/orchestrator framework;
- no legacy execution migration;
- Platform execution/narrative machinery is deleted after qualification.

The objective is subtraction: keep the controller boring and trustworthy; teach the agent how to use that framework intelligently.