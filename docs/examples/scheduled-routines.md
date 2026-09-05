# Scheduled routines

Scheduled routines let an ordinary Agent Bridge workstream create one-shot or recurring future work. The scheduled occurrence returns through the same provider-neutral Run path as an interactive message; it is not a separate job or workflow engine.

The bundled `scheduled-routines` skill owns the setup contract. Create routines through a normal companion conversation so Agent Bridge can bind the routine to the current canonical conversation and delivery surface.

## Recurring example

In the workstream where you want the report delivered, ask:

```text
Every weekday at 08:00 Europe/London, review this repository's open pull requests and tell me which ones need my attention.
```

The agent should reflect back the exact instruction, recurrence, time, and IANA timezone, then obtain explicit confirmation before creating the routine.

## One-shot example

```text
Tomorrow at 14:00 Europe/London, remind me to review the release candidate and include the current test and CI state.
```

Again, the routine should be confirmed before creation.

## What remains attached to the workstream

A companion routine records the canonical conversation context needed to re-enter the same workstream. When the occurrence becomes due, Agent Bridge creates the ordinary interactive turn and uses the existing provider selection, session, persistence, cancellation, and delivery path.

For Telegram topic workstreams, this means the scheduled result returns to the topic rather than only to the containing group. For Discord, it returns through the bound Discord conversation.

## Inspecting routines

The `scheduled-routines` skill uses the installed `agent-bridge-routines` helper for durable create/list/update/delete operations. Prefer asking the agent to inspect or change a routine from the bound workstream rather than creating an unrelated operating-system cron entry.

Do not use external cron as a substitute for a companion routine when you need Agent Bridge conversation identity, provider continuity, or normal Run semantics.
