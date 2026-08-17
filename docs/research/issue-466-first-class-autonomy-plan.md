# Issue #466 — first-class autonomous Agent Bridge implementation plan

Status: architecture/implementation plan only. No production behavior changes in this PR.

## Decision

Promote the autonomous runtime we already built into a first-class capability of the existing interactive Agent Bridge service.

This is **reuse + small composition seams + subtraction**, not a new autonomous system.

The architectural split is:

- **Agent Bridge/controller:** mechanical durability, isolation, concurrency, budgets, restart, cancellation, bounded transport/correlation.
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
8. generic durable supervisor-route/message/input correlation using existing receipt primitives where safe.

No new persistence table is expected if `event_receipts` can represent these generic correlations cleanly.

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

The provider decides what it needs to know before a material decision and chooses the cheapest reliable permitted source, such as safe authoritative DB/report access, filesystem/repository/git, logs/service/runtime, existing CLI/API, projected Skills/domain tools, web/search, or domain-owned helpers.

Prior evidence is continuity, not automatically current truth.

A new cycle does **not** mean “run all sensors”. It is another opportunity to observe, reason and act.

If repeated observation is materially cheaper/faster/more reliable to mechanise, the domain agent may create a query/script/report/check/Skill in its writable workspace.

OSS must not gain a Company/domain sensor registry, sensor schema, mirrored domain-state tables, sensor scheduler/poller, mandatory refresh service, Farstax observation API, or mandatory per-cycle sensor call.

## Intelligent supervised communication

The supervised experiment needs useful progress communication and a way for the supervising human to question/steer work.

The runtime must **not** generate narrative from cycle fields. The provider agent authors the communication.

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

- `evidence` = durable execution evidence;
- `nextWakeReason` = mechanical successor intent;
- `supervisorMessage` = optional human-facing text written by provider;
- Bridge validates/bounds/transports it without rewriting prose;
- Bridge never synthesizes/summarizes/templates it;
- absent field means no message just because a cycle ended.

Use a conservative bound (for example <=3,000 characters) and teach conversational prose rather than tables/attachments so the initial Telegram path uses one normal text message with a concrete `message_id`.

The `autonomous-work` Skill teaches when communication matters: material decisions, changed direction, meaningful progress, changed understanding, risk/uncertainty, useful questions and terminal review. It explicitly discourages ceremonial cycle summaries/tool narration.

### Initial scope: cycle-boundary dialogue

Do **not** build a mid-Run messaging broker initially.

Cycle boundaries are already durable reasoning checkpoints. Deliver `supervisorMessage` after successful reconciliation. If real qualification shows cycles are too long for useful supervision, create a later issue for a generic provider-side supervisor capability using existing scoped-broker patterns.

No inter-cycle grace period/approval delay is introduced. `drainAutonomousGoal()` remains free to continue.

## Durable supervisor route is transport state, not owner-gate state

The current Telegram experiment must continue sending/receiving supervised dialogue after process restart. Therefore each supervised episode needs a durable **route binding** independent of in-memory command context.

Generic start input may include an optional bounded route, conceptually:

```ts
supervisorRoute?: {
  surface: string;
  address: string;
  identity?: string;
  thread?: string;
}
```

Current Telegram adapter binds:

- surface = Telegram;
- address = authenticated chat ID;
- identity = authenticated owner user ID;
- thread when applicable.

Persist this binding atomically with creation of a newly-created episode/initial wake using existing generic receipt/correlation storage if practical. Do not add `owner_id`, `owner_approved` or Telegram columns to `autonomous_goals`.

The route means only **where/which authenticated supervisor this episode is bound to for dialogue**. It does not authorize the episode and does not make owner approval permanent runtime policy.

If `start()` returns an already-active episode, do not silently rebind its supervisor route to the caller.

On restart, route binding remains available for future supervisor messages/replies.

A future start policy may supply a different supervisor surface or no supervisor at all without schema/lifecycle replacement.

## Telegram delivery and reply identity

The existing Telegram text/entity delivery path returns the first `message_id`; richer document/table routes may return `null`.

Supervisor messages need reply identity, so use/expose the existing **normal text-message** path. Do not route supervisor updates through document/rich fallbacks.

After successful send, record bounded correlation:

```text
goalId + runId + cycle + supervisor route + Telegram message_id
```

Prefer existing receipt/correlation storage. This is not a durable notification outbox.

Delivery is best-effort and never rolls back reconciled autonomous work. Delivery error is caught/logged and episode continues. Do not automatically replay a supervisor narrative after restart merely to guarantee messaging.

A reply correlation is valid only for the goal that emitted that message. A reply to a message from an older terminal/different episode must never steer the current episode.

## Supervisor questions and steering

Preferred current Telegram flow:

1. provider authors optional `supervisorMessage`;
2. adapter resolves persisted route, sends one normal text message and records returned message ID against that goal;
3. bound authenticated owner replies naturally to that correlated Company message;
4. adapter verifies reply sender/route and goal correlation;
5. if that same goal is still active, bounded reply is durably/idempotently recorded as generic `supervisor_input`;
6. earliest later cycle whose input-claim transaction has not committed receives it in a separate prompt section;
7. provider decides whether it is a question, context, tactical steering, or a request exceeding current authority.

If the correlated goal is terminal or no longer current, do not inject the reply into another episode; leave it on the ordinary interactive path (or require a new authorized episode for new work).

Input arriving while a Run is already executing is never injected into that running provider. If next cycle already claimed inputs, reply naturally reaches a later one. `/autonomy stop` remains immediate intervention.

Do not use NLP to guess whether arbitrary chat is steering. Prefer explicit Telegram reply correlation. Add command fallback only if live Telegram qualification proves replies insufficient.

A genuinely blocking request for new authority may terminate `blocked`; later authorized episode can receive new instruction via normal start policy.

Do not add `awaiting_owner`, pause, supervisor-conversation or approval-series lifecycle states.

### Telegram type seam

Current `TelegramMessage` does not model Telegram reply metadata. Add only the narrow `reply_to_message` information needed for message-ID/sender correlation. Ordinary non-correlated replies must continue through normal interactive routing.

## Reuse event receipts correctly for supervisor dialogue

`event_receipts` is already the generic durable/idempotent ingress/correlation primitive and is the preferred seam for supervisor route/message/input records.

But current autonomous wake discovery is too broad for multiple autonomous event kinds.

Before introducing supervisor receipt kinds:

- `pendingWake()` filters `event_kind = AUTONOMOUS_EVENT_KIND` (`goal_wake`);
- `recoverableWake()` filters wake kind;
- `claimWakeAndRun()` defensively verifies wake kind plus source/status;
- audit every wake-specific autonomous receipt query/update and remove source-only wake assumptions;
- regression proves `supervisor_route`, `supervisor_message` and `supervisor_input` receipts are never selected/claimed/recovered as wakes.

Use distinct event kinds rather than overloading `goal_wake`.

### Supervisor input claim semantics

Supervisor input must never become evidence or be consumed before execution assignment.

When a wake is claimed and ordinary Run created, atomically associate currently pending bounded `supervisor_input` receipts for that goal with the same cycle Run using existing receipt status/run correlation where practical.

Build prompt with a distinct:

```text
Supervisor input since previous cycle:
...
```

After successful cycle reconciliation, mark associated supervisor inputs consumed/completed. If Run becomes ambiguous at provider boundary, existing fail-closed restart behaviour applies; do not replay provider merely to re-consume input.

This provides durable at-most-one-cycle assignment without a message table. If receipt status semantics cannot do this safely, prove the conflict with a red test before adding persistence.

## Teach autonomous work through one OSS Skill

Add `skills/autonomous-work/SKILL.md` through existing Skill machinery.

Teach provider to:

1. understand `Goal -> Episode -> Cycle -> Run`;
2. distinguish frozen objective, prior evidence, supervisor input and current truth;
3. decide dynamically what needs observing;
4. verify material claims against authoritative sources;
5. act rather than merely report;
6. use normal provider/Skill/tool capabilities;
7. return strict bounded cycle result;
8. provide concrete `nextWakeReason` for `progress`;
9. keep supervisor usefully informed without ceremonial reporting;
10. write supervisor messages in its own judgement/voice;
11. answer questions/use tactical steering within authority;
12. never interpret dialogue as implicit authority expansion;
13. mechanise repeated observations only when justified;
14. understand budget exhaustion ends episode, not persistent goal.

Skill is provider-neutral and contains no Farstax/Company semantics.

## Skill deployment must converge

Adding folder alone is insufficient. Reuse/update default bundled Skill install/parity paths so `autonomous-work` is installed/projected/verified on fresh install, exact-release install, existing deployed appliance upgrade, Codex, Claude and Agy.

If guarded rollout does not reconcile new defaults on existing hosts, add smallest generic reconciliation at existing install/upgrade/deploy boundary—not autonomy controller.

## Workspace: immutable authority, writable learning

Representative workspace:

```text
company-workspace/
  AGENTS.md
  AUTONOMY.md
  CONTEXT.md          # optional static context only
  mission.md
  goals.md
  operating-model.md
  constraints.md
  SOUL.md
  skills/
  work/
```

Canonical controls are runtime-readable but not runtime-replaceable. A runtime-writable parent can replace root-owned children, so Platform must provide a real directory ownership boundary.

`work/` is durable runtime-writable learned work; generic lifecycle/restart/cleanup must not erase it.

## Generic runtime/config

```text
AGENT_BRIDGE_AUTONOMY_DIR=/absolute/path/to/workspace
AGENT_BRIDGE_AUTONOMY_DB_PATH=/absolute/path/to/autonomy.sqlite
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3   # generic default
```

Farstax explicitly sets 20.

Do not add autonomy-specific provider, credentials, HOME/PATH, Skill path, arbitrary env overlay or sensor settings.

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

Controller owns only:

- autonomy DB lifecycle/isolation;
- prompt freezing;
- atomic single-active creation;
- durable supervisor route/correlation;
- start/drain/cancel/restart delegation;
- bounded status;
- bounded supervisor input assignment;
- cycle event/delivery plumbing;
- shutdown cleanup.

It does **not** decide what matters, what to observe, what deserves communication, how to explain a decision, how to answer questions, or what tactical choice to make.

Design test: could the controller run a research project, software team, personal assistant or Company without knowing which one? If not, behaviour leaked into mechanics.

### Atomic start

Add narrow create-if-none-active helper beside existing creation. One transaction owns active check + new episode + initial wake + optional supervisor-route binding for the newly-created episode. Zero creates; one returns existing without rebinding; >1 fails closed.

### Status/stop/restart

Generic status is execution state only (`idle`, `running`, latest terminal bounded view). No persisted `idle`/`awaiting_owner`.

`stop()` delegates to existing cancellation/fencing. Startup recovery uses existing wake/provider semantics plus persisted supervisor route. No timer/poller.

## Owner approval remains temporary adapter policy

Current authenticated `/autonomy approve` is today's policy allowed to call `start()`. It supplies current Telegram supervisor route, but route binding is transport, not authorization state.

Do not persist owner approval/gate/series state. Future authorized start policy may change independently.

## Provider selection

Reuse normal interactive provider preference/availability. Fail before creation if none launchable; store existing bot; restart uses stored provider. No autonomy provider registry/fallback.

## Option 2 execution-context proof

Prove explicit autonomous cwd/static context in `BridgeEngine` without process-global mutation and across retries/fallback/continuations. If this requires invasive env virtualization/provider-specific code, use minimal dedicated generic OSS service instead.

## Implementation slices

### A — execution-context isolation

Red/green explicit cwd/context and no global mutation.

### B — core controller

Red/green atomic start, frozen prompt, evidence-vs-policy, supervisor route persistence/non-rebinding, maxCycles, status/stop, restart/stored provider, >1 active fail closed.

### C — `autonomous-work` Skill + deployment convergence

Add Skill through existing machinery; prove provider use and fresh/upgraded projection.

### D — supervised dialogue on existing Telegram

Red/green:

- strict parser accepts optional bounded `supervisorMessage`;
- message stays in one normal text delivery;
- no message when field absent;
- provided prose delivered without rewriting;
- text delivery returns message ID;
- delivery failure cannot alter reconciled state;
- supervisor route survives restart and existing active episode cannot be silently rebound;
- Telegram type/parser exposes narrow reply metadata;
- ordinary non-correlated replies stay ordinary chat;
- outbound correlation is bound to exact goal/run/cycle;
- stale/terminal/different-goal reply never steers current episode;
- wake-specific receipt paths filter `goal_wake` event kind;
- supervisor receipts never masquerade as wakes;
- duplicate Telegram update does not duplicate input;
- cycle claim atomically assigns pending input to Run;
- prompt distinguishes input from evidence;
- input arriving after claim affects later cycle, never running provider;
- no inter-cycle wait;
- tactical steering cannot mechanically expand authority;
- `/autonomy stop` immediately intervenes;
- no second bot/poller, narrative engine, pause lifecycle or mid-Run broker.

### E — current Telegram experiment adapter

Keep `/autonomy approve|status|stop`. Mechanical status is not primary progress narrative; provider-authored messages are.

### F — Platform pack/access cutover

Tracked by Platform #352.

### G — Platform execution subtraction

After qualification delete old Platform Company execution/narrative machinery.

## Real qualification

Prove at minimum:

1. one existing interactive Telegram poller/token;
2. one authorized start creates one bounded episode plus durable supervisor route;
3. restart preserves provider and supervisor delivery route;
4. active episode cannot be rebound by another caller;
5. prompt/authority frozen at start;
6. canonical controls immutable and `work/` durable;
7. provider/cwd/context/Soul/Skills use existing safe paths;
8. `autonomous-work` converges on upgraded host;
9. autonomy DB distinct from interactive DB;
10. each cycle receives frozen prompt + prior evidence + wake reason + assigned supervisor input;
11. provider chooses observations dynamically;
12. provider itself authors useful supervisor message when material;
13. no mechanical message solely because cycle ends;
14. message delivered as one text message and correlated to exact goal;
15. owner replies through same bot; unrelated chat still normal;
16. reply reaches one later cycle exactly once and never masquerades as wake;
17. reply to stale/terminal episode cannot steer newer episode;
18. no inter-cycle pause; reply affects earliest later unclaimed cycle;
19. urgent stop fences execution;
20. `progress` creates exactly one successor while budget remains;
21. Farstax 20 cycles; cycle-20 progress -> `budget_exhausted`; no cycle 21;
22. no successor episode without current start-policy authorization;
23. no legacy Company execution state imported.

Live proof should show a real Company decision, intelligent agent-authored Telegram update, owner reply, later-cycle incorporation and restart-safe supervisor routing with no Platform orchestration.

## No legacy migration

Start fresh autonomy DB. No copying/mapping/replay/dual-write/reverse migration of old Company execution state.

## Acceptance

- existing lifecycle/provider/Skill primitives reused;
- `Goal -> Episode -> Cycle -> Run` remains model;
- authority frozen at start;
- evidence, supervisor input, policy instruction and current truth distinct;
- controller boring/mechanical/domain-neutral;
- provider/Skill owns observation, judgement and communication;
- messages are intelligent provider-authored content, never generated narrative;
- generic durable supervisor route supports restart without embedding owner approval;
- current owner uses existing Telegram bot as supervisor surface;
- stale replies cannot steer another episode;
- Telegram reply identity explicit and ordinary chat unaffected;
- event-kind filtering prevents supervisor receipts becoming false wakes;
- no inter-cycle wait or mid-Run broker without evidence;
- Skill converges fresh/upgraded;
- canonical controls immutable, learned work durable;
- sensors remain optional domain work;
- owner approval temporary start policy;
- maxCycles generic, Farstax 20;
- no Company/sensor/narrative/scheduler/worker/second-poller/orchestrator framework;
- no legacy migration;
- Platform execution/narrative machinery deleted after qualification.

The objective is subtraction: keep the controller boring and trustworthy; teach the agent how to use the framework intelligently.