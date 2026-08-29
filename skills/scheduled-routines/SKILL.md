---
name: scheduled-routines
description: Align with the user on an explicit future or recurring instruction, then create, inspect, disable, or delete the agreed companion routine.
---

# Scheduled routines

Use this Skill when the user asks the companion to do something later or repeatedly.

## Align before scheduling

Do not create a routine merely because a time or recurrence was mentioned. For non-trivial work, first use the ordinary conversation to settle:

- the exact instruction that should run;
- whether it is a normal companion Run or an explicitly autonomous Episode start;
- one-shot or recurring timing;
- timezone.

Before creating anything durable, show the final instruction and timing in a concise confirmation and obtain explicit user agreement. The provider owns this alignment conversation; Agent Bridge does not parse natural-language schedules into authority on its own.

Creating the routine is standing, revocable authority only to submit that stored instruction at the agreed times. It does not grant additional tool, provider, repository, credential, deployment, production, or consequential-action authority. Existing Run/tool rules remain authoritative.

Never infer routines from habits. Never create or modify a routine from a scheduled-triggered Run. An autonomous Cycle also must not create or broaden schedules unless a current authenticated user conversation separately authorizes it.

## Routine types

Use `companion` for normal proactive work such as briefings, reminders that need reasoning, status reviews, or scheduled questions. The occurrence returns to this same companion conversation and uses its existing session, queue, provider routing and delivery.

Use `autonomous` only when the user explicitly asks to autonomously work/make progress until done or blocked. Scheduled autonomy currently requires the Telegram first-class autonomy surface. The routine wake starts the existing bounded autonomy controller; it does not create another autonomy implementation.

## Helper

Routine management is scoped mechanically to the current canonical conversation and authenticated owner. Derive the helper beside the existing context command:

```sh
ROUTINES="$(dirname "$AGENT_BRIDGE_CONTEXT_COMMAND")/agent-bridge-routines"
```

If `AGENT_BRIDGE_CONTEXT_COMMAND`, `AGENT_BRIDGE_CHAT_KEY`, `AGENT_BRIDGE_SURFACE_IDENTITY`, `AGENT_BRIDGE_CONTEXT_DB`, or `AGENT_BRIDGE_OWNER_KEY` is unavailable, do not work around the boundary. Continue the alignment conversation and create the routine only from a later confirmed turn where the scoped helper is available.

List this conversation's routines:

```sh
bash "$ROUTINES" list
```

Create a one-shot routine only after explicit confirmation:

```sh
bash "$ROUTINES" create \
  --name "Release check" \
  --instruction "Check the current release candidate and tell me whether it is ready." \
  --kind companion \
  --timezone "Europe/Madrid" \
  --once "2026-08-30T10:00"
```

Create a recurring routine:

```sh
bash "$ROUTINES" create \
  --name "Morning priorities" \
  --instruction "Review current work and tell me the top three priorities, prioritizing release blockers." \
  --kind companion \
  --timezone "Europe/Madrid" \
  --weekly "mon,tue,wed,thu,fri" \
  --time "08:00"
```

For explicitly autonomous work, use `--kind autonomous` and keep the stored instruction narrower than the ambient autonomy authority.

Disable or delete only a routine returned by `list` in this conversation:

```sh
bash "$ROUTINES" disable <routine-id>
bash "$ROUTINES" delete <routine-id>
```

For a material instruction change, align on the replacement with the user first. Prefer creating the confirmed replacement and removing the old routine rather than inventing an implicit edit or widening its standing authority.

## Scheduling semantics

Schedules use an explicit IANA timezone. Weekly weekdays are Monday=1 through Sunday=7 (weekday names are accepted by the helper). Each intended occurrence is claimed at most once. After restart, a recent missed occurrence may run once; stale occurrences are skipped. A one-shot routine expires after its occurrence is claimed, including when that occurrence is already stale.

Do not build or simulate cron expressions, webhook workflows, Task graphs, event buses, retry state machines, or a second execution engine in this Skill.
