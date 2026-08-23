---
name: requirements-to-acceptance
description: Use when turning product requests, bug reports, or ambiguous implementation asks into a small observable contract, affected boundaries, acceptance criteria, and verification plan.
---

# Requirements To Acceptance

Use before implementation when the outcome is ambiguous, user-facing, cross-functional, security-sensitive, operational, or likely to cross module boundaries.

## Define the contract

Keep only what changes engineering decisions:

1. State the intended observable outcome and important non-goals.
2. Identify the actor, resource, and intended authority when identity or permissions matter.
3. Map the affected surfaces only: user/runtime journey; state (DB/files/config/migration); runtime (process/user/PATH/env/executable/service); delivery (install/upgrade/reconcile/restart/rollback); external contract; and final consequential credential/permission.
4. For a non-trivial change, ask: **If this ships and causes a defect, what are the most plausible reasons?** Retain only credible answers that change the affected surfaces, acceptance criteria, or verification. Do not create a mandatory premortem section or speculative risk list.
5. Express acceptance as user/system-observable behavior and meaningful failure behavior. Prescribe implementation only for a real architecture, security, compatibility, or operational invariant.
6. Name the evidence that will prove the contract before selecting the implementation or red test.

For security, identity, credential, account/repository selection, installation, or permission changes, trace:

`actor -> authentication -> selection -> durable state -> credential -> target -> operation`

The authority at the final consequential operation is the boundary that must be proven.

For multiple issues, split only when the pieces are independently valuable or have a real dependency. A claimed dependency must have an output/state from the earlier step that the later step actually consumes.

Ask a question only when the missing answer would make a reasonable implementation unsafe or materially change product intent. Otherwise state the assumption and continue.
