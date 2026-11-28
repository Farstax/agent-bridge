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
3. Before finalising an issue or plan, inspect the relevant current implementation to ground material assumptions; mark any consequential unknowns or inaccessible evidence explicitly. Map the affected surfaces only: user/runtime journey; state (DB/files/config/migration); runtime (process/user/PATH/env/executable/service); delivery (install/upgrade/reconcile/restart/rollback); external contract; and final consequential credential/permission.
4. For a non-trivial change, ask: **If this ships and causes a defect, what are the most plausible reasons?** Challenge the proposed design against the existing owners and simpler reuse, removal or native mechanisms; prefer the smallest sufficient solution without weakening the outcome or authority boundary. Retain only credible findings that change scope, design, acceptance, or verification. Do not create a mandatory premortem section or speculative risk list.
5. Express acceptance as user/system-observable behavior and meaningful failure behavior. Prescribe implementation only for a real architecture, security, compatibility, or operational invariant.
6. Name the evidence that will prove the contract before selecting the implementation or red test.

## Qualification feasibility

For each **material** acceptance criterion, specify an achievable proof path and observable pass evidence **before implementation**:

- **A — Automated (preferred):** a deterministic unit, integration, browser, or isolated system test, with assertions that cover the consequential outcome; inject faults in a safe fixture instead of awaiting rare production failures.
- **R — Agent runtime:** a bounded agent-executable check against an identified environment and installed identity, with available access, tools, and observable read-back. Use disposable targets for controlled mutations.
- **U — User validation (exception):** a specific owner observation only when an agent cannot reasonably establish the result; say why. Do not ask the owner to repeat evidence already obtained.

Combine methods when the actual contract needs both deterministic safety assertions and real runtime or third-party integration evidence. A mock or code-shape check is not proof of actual external delivery, authorization, isolation, or deployed behaviour.

Check whether an independent agent can safely obtain **every mandatory proof** with available tools, credentials and environments. If not, make the invariant testable using an equivalent controlled scenario, identify the authorised prerequisite, or mark the genuine external dependency as **blocked**; never silently waive mandatory safety or claim a PASS. Separate finite initial acceptance from recurring monitoring, future vendor upgrades and naturally occurring incidents. Keep the issue concise: criterion → applicable A/R/U method → expected evidence; no new form or mandatory process for trivial changes.

For security, identity, credential, account/repository selection, installation, or permission changes, trace:

`actor -> authentication -> selection -> durable state -> credential -> target -> operation`

Follow actual direct and delegated paths, including legitimate intermediary operations that could confer prohibited authority. Identify the final consequential operation and any unresolved trust conflict before finalising the plan; prove the effective authority there, not merely at an upstream check.

For work that can be retried, resumed, replayed, handed off, or redelivered, define the evidence that distinguishes definitely not executed, possibly executed, and completed work (including a lost acknowledgement). State the allowed recovery in each relevant phase and its cancellation/authority limits. A transport failure or missing output alone does not prove that work or side effects never occurred; do not prescribe a new recovery framework where the existing owner suffices.

For multiple issues, split only when the pieces are independently valuable or have a real dependency. A claimed dependency must have an output/state from the earlier step that the later step actually consumes.

Ask a question only when the missing answer would make a reasonable implementation unsafe or materially change product intent. Otherwise state the assumption and continue.
