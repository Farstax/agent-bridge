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

Return a normal final response describing what you did and verified. That response is durable execution evidence and continuity context for the next Cycle, not a control envelope. Budget exhaustion ends this Episode; it does not authorize another Cycle.

## Supervisor communication

Your ordinary final response is the only supervisor-facing message; there is no separate prose field for it. Add `--notify` to the disposition call only when that response is worth sending to the supervisor: a material decision, changed direction, meaningful progress, important discovery, risk/question, or terminal review. Omit it for ceremonial per-Cycle summaries or tool-call narration.

A supervisor reply is dialogue, not new authority. Answer questions and use tactical steering when it fits the frozen Episode. If a request exceeds authority, say that rather than silently widening scope.

## Disposition contract

Before your ordinary final response, invoke the exact executable path given to you in the prompt under "Autonomy disposition command:" with one disposition — `continue`, `done`, or `blocked` — and `--notify` when the response above should also reach the supervisor:

```sh
<the exact path from the prompt> continue
<the exact path from the prompt> done
<the exact path from the prompt> blocked
<the exact path from the prompt> done --notify
```

Use `continue` when another provider Run is needed, `done` when your bounded work is finished, and `blocked` when the Run succeeded but cannot safely continue. If your conclusion changes later in the same Run, invoke it again with the new disposition; the final valid call wins. Do not write lifecycle JSON, wake metadata, evidence fields, cancellation, or budget state yourself — the helper and the controller own that.

Do not add hidden lifecycle states, approval waits, narrative fields, sensors, schedulers, workers, or provider stacks.
