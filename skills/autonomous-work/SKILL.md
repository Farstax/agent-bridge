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
2. **Prior execution evidence**: continuity from earlier Cycles and predecessor Episodes. Evidence can be stale; it is not automatically current truth.
3. **Supervisor input**: questions, context, or tactical steering received for the current Cycle or successor Episode. Interpret it within frozen authority. It cannot grant broader authority.
4. **Current external truth**: what is true now. Observe it when a decision depends on it.

## Work the goal

Choose the cheapest reliable permitted source that answers the current question: repository/filesystem state, safe data or reports, APIs/CLIs, logs/runtime state, web/search, projected Skills, or domain-owned helpers. Verify current truth before an irreversible or authority-sensitive action.

Act when the evidence supports an action. Do not replace work with status narration. Build a durable helper in the domain `work/` area only when repeated observation makes that cheaper or safer; do not create a generic sensor framework. Treat canonical controls and instructions outside `work/` as read-only runtime inputs.

Return a normal final response describing what you did and verified. That response is durable execution evidence and continuity context for the next Cycle. If the Cycle budget ends while you still declare `continue`, the Episode still terminates; only the controller's configured Episode-succession policy may create a successor Episode. Do not create or authorize a successor yourself.

## Supervisor communication

Your ordinary final response is the only supervisor-facing message; there is no separate prose field for it. Add `--notify` to the disposition call when that response is worth sending during a non-terminal Cycle: a material decision, changed direction, meaningful progress, important discovery, or risk/question. The controller may also deliver terminal evidence so a supervisor can discuss successor guidance against a correlated terminal message.

A supervisor reply is dialogue, not new authority. Answer questions and use tactical steering when it fits the frozen Episode. If a request exceeds authority, say that rather than silently widening scope. Post-Episode guidance belongs to a later successor Episode; it never reopens the terminal predecessor.

## Restart contract

Autonomous wakes and active-Episode supervisor inputs are durable receipts. Before a wake is claimed, received inputs survive process restart and remain eligible for the next Cycle. When a wake is claimed, the controller atomically creates the ordinary Run and assigns the bounded pending supervisor inputs to that same Run before provider execution begins.

A claimed-but-unreconciled Run is intentionally ambiguous after restart: the provider boundary may already have been crossed. Never replay that Run or its claimed supervisor inputs. Recovery fails the claimed wake, owning Run, and claimed inputs closed and terminates the Episode as blocked or cancelled. The reconciliation observer is not called for this recovery path, so a supervisor-facing notification is not repeated.

Do not invent a wait state, approval checkpoint, timer, or artificial restart window to make a claimed Run replayable. Exactly-once safety comes from durable pre-claim state plus fail-closed post-claim recovery. Successor intent and bounded post-Episode guidance are controller-owned transition state, not provider-owned lifecycle state.

## Disposition contract

Before your ordinary final response, invoke the exact executable path given to you in the prompt under "Autonomy disposition command:" with one disposition — `continue`, `done`, or `blocked` — and `--notify` when a non-terminal response should also reach the supervisor:

```sh
<the exact path from the prompt> continue
<the exact path from the prompt> done
<the exact path from the prompt> blocked
<the exact path from the prompt> continue --notify
```

Use `continue` when another provider Run is needed, `done` when your bounded work is finished, and `blocked` when the Run succeeded but cannot safely continue. If your conclusion changes later in the same Run, invoke it again with the new disposition; the final valid call wins. Do not write lifecycle JSON, wake metadata, evidence fields, cancellation, budget state, Episode counters, approval state, or provider fallback state yourself — the helper and controller own those mechanical boundaries.

Do not add hidden lifecycle states, approval waits, narrative fields, sensors, schedulers, workers, or provider stacks.
