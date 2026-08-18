---
name: advisor
description: Get one bounded independent frontier opinion from a configured provider when the user asks for a second opinion or when an independent view would materially improve a decision.
---

# Advisor

Use this Skill only when an independent cross-provider opinion is useful. Agent Bridge itself does not suggest or auto-run it.

## Contract

- Ask one small decision-bearing question.
- Include only the bounded context needed to answer it. Do not send secrets or a full transcript.
- The advisor provider must differ from the active provider and must be configured by Agent Bridge.
- Make one advisor call only. Do not cascade or retry through other providers.
- Treat the result as non-authoritative input. The active agent keeps execution ownership and decides what to do.

Run:

```sh
"$AGENT_BRIDGE_ADVISOR_COMMAND" --question "<question>" --context "<small relevant context>"
```

To request a specific configured independent provider, add `--provider claude`, `--provider codex`, or `--provider agy`.
