# Autonomous executive loop spike

Status: research prototype for issue #389. This document records the boundary
proved by the deterministic harness. It does not authorise unattended
production execution.

## Result

The smallest useful boundary is a durable goal, a deduplicated successor wake,
and an ordinary Run owner. A cycle can persist evidence and create the reason
for its successor without a user message. A coordinator restart can rediscover
that successor wake and create one owning Run for it.

The prototype does not add a production scheduler, a resident worker, a schema
migration, or a Bridge-owned subagent model. Existing persistence and
`BridgeEngine.executeSurfaceNeutralTurn` remain the intended production seam.

## Lifecycle

```text
goal + constraints
      |
      v
durable wake (deduplicated key)
      |
      v
ordinary Run owner
      |
      v
provider executive + native tools/subagents
      |
      v
evidence + terminal result + successor wake intent
      |
      v
sleep / restart / rediscover wake
```

The successor wake is the important proof. Three calls from a test do not show
autonomy. Each non-terminal cycle must persist enough intent for a later cycle
to become runnable without a new user instruction.

## Boundary ownership

Agent Bridge owns goal identity, wake deduplication, ordinary Run identity,
cycle bounds, cancellation/fencing, authority inheritance, and evidence
persistence. The provider owns planning, decomposition, native subagents or
teams, parallel work, critique, and tool strategy inside its Run.

The current provider boundary already carries provider-specific session,
output-format, execution-mode, workspace, and tool-mode data. Claude uses
stream JSON for continuation work, Codex uses JSON, and Antigravity has its
own stream output handling. The spike does not flatten those protocols into a
Bridge subagent API.

## Deterministic evidence

`test/autonomousExecutiveLoop.test.ts` proves:

- one goal drives three bounded cycles;
- duplicate wake delivery creates one logical owning Run;
- a coordinator restart after successor intent preserves the next cycle;
- the maximum cycle bound produces `budget_exhausted`.

The test uses `InMemoryAutonomousGoalStore` and a fake provider executor. This
separates lifecycle correctness from provider availability and model output.
The next qualification step is one controlled live-provider smoke that checks
native delegation capability. It must remain bounded and must not change
production state.

## Persistence decision

No schema change is justified by this spike. The harness proves the required
state transition and leaves the production adapter to a later issue. A future
adapter must use the existing ordinary Run and event/receipt ownership path,
then add only the smallest durable goal/wake linkage that code inspection and
restart tests require.

## Safety and stop conditions

Every cycle has a maximum-cycle bound. A production adapter must also enforce a
Run deadline, cancellation and exact lane fencing, workspace and authority
inheritance, and provider-attempt limits visible at the Bridge boundary. It
must stop with a terminal blocked, cancelled, complete, or budget-exhausted
state. Provider-native worker counts are not a Bridge budget because they are
provider-internal.

The prototype must not become a resident autonomous worker, silently expand
permissions, create `work_items` or `work_jobs`, persist provider subagents as
Bridge entities, or introduce a second execution owner.

## Recommendation

The executive-loop hypothesis is sufficiently demonstrated to justify a
follow-up production-adapter design. Keep scheduling and schema work out of
this spike. The follow-up must first map a durable wake source to the existing
health/event receipt and `executeSurfaceNeutralTurn` boundaries, then add
restart and duplicate-delivery tests before any unattended rollout.
