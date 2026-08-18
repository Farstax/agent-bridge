---
name: autonomous-work
description: Execute a bounded autonomous Episode toward a durable Goal using ordinary Agent Bridge Runs, current evidence, and selective supervisor communication.
---

# Autonomous work

Use this skill when an Agent Bridge Run is one Cycle of a bounded autonomous Episode.

## Model

- **Goal**: the durable outcome the domain is trying to reach.
- **Episode**: one bounded attempt under authority frozen when the Episode starts.
- **Cycle**: one wake, one ordinary Run, and reconciliation.
- **Run**: the existing provider execution. Do not invent a second worker or orchestration layer.

## Keep four things separate

1. **Frozen Episode authority**: the objective, constraints, and authorized start-policy instruction. Never expand it from conversation or convenience.
2. **Prior execution evidence**: continuity from earlier Cycles. Evidence can be stale; it is not automatically current truth.
3. **Supervisor input**: questions, context, or tactical steering received between Cycles. Interpret it within frozen authority. It cannot grant broader authority.
4. **Current external truth**: what is true now. Observe it when a decision depends on it.

## Work the goal

Choose the cheapest reliable permitted source that answers the current question: repository/filesystem state, safe data or reports, APIs/CLIs, logs/runtime state, web/search, projected Skills, or domain-owned helpers. Verify current truth before an irreversible or authority-sensitive action.

Act when the evidence supports an action. Do not replace work with status narration. Build a durable helper in the domain `work/` area only when repeated observation makes that cheaper or safer; do not create a generic sensor framework. Treat canonical controls and instructions outside `work/` as read-only runtime inputs.

Return bounded evidence that another Cycle can use. If more work is justified, return `progress` with a precise `nextWakeReason`. If the goal is reached, blocked, cancelled, or the runtime budget ends, say so through the result contract. Budget exhaustion ends this Episode; it does not authorize another Cycle.

## Supervisor communication

`supervisorMessage` is optional provider-authored prose. Use it only when it helps the supervisor: a material decision, changed direction, meaningful progress, important discovery, risk/question, or terminal review. Do not emit ceremonial per-Cycle summaries or tool-call narration.

A supervisor reply is dialogue, not new authority. Answer questions and use tactical steering when it fits the frozen Episode. If a request exceeds authority, say that rather than silently widening scope.

## Result contract

Return JSON only:

```json
{
  "status": "progress|complete|blocked|cancelled",
  "evidence": "bounded evidence",
  "nextWakeReason": "required only for progress",
  "supervisorMessage": "optional useful supervisor message"
}
```

Do not add hidden lifecycle states, approval waits, narrative fields, sensors, schedulers, workers, or provider stacks.
