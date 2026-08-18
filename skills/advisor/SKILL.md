---
name: advisor
description: Get one bounded independent frontier opinion from a configured provider when the user asks for a second opinion or when an independent view would materially improve a decision.
---

# Advisor

Use this Skill only when an independent frontier opinion has enough expected value to justify one extra model call. Agent Bridge itself does not suggest or auto-run it.

## How to use it

- Ask one small, decision-bearing question. Include only the context needed to answer it; do not send secrets or a full transcript.
- When independence matters, request a configured provider different from the active provider. The Bridge chooses that provider's configured frontier/advisor model; do not try to select an arbitrary model.
- Make one call only. Do not cascade, retry through another provider, or turn the advisor into a second executor.
- Separate evidence you already have from your inference when framing the question.
- Treat the answer as non-authoritative input. If it disagrees with your current view, surface the disagreement and decide from the evidence instead of averaging the conclusions.
- Incorporate useful advice into the primary task yourself. You keep execution ownership and remain responsible for validation.
- Skip the call when the likely decision impact is small.

Run:

```sh
"$AGENT_BRIDGE_ADVISOR_COMMAND" --question "<question>" --context "<small relevant context>"
```

To request a specific configured independent provider, add `--provider claude`, `--provider codex`, or `--provider agy`.
