---
name: engineering-retro
description: Use when reviewing a recent body of engineering work, one release, or a set of releases to identify repeated human intervention and reusable friction worth fixing.
---

# Engineering retro

Use this skill only for an explicit retrospective on completed or substantially completed work. It does not change the delivery workflow for active work.

## Scope the evidence window

Start from the requested window: recent work, one release, a release range, or another bounded set of completed engineering work. Do not force the retro to revolve around one issue when the evidence spans several changes.

Use existing evidence only. Prefer, in order:

1. retained Agent Bridge conversation turns for owner requests, corrections, questions, reminders, and completion reports;
2. GitHub issues, pull requests, reviews, commits, and release history for what changed and where repair loops occurred;
3. CI and qualification evidence for avoidable failures, reruns, and gaps between local and hosted checks;
4. current repository instructions, Skills, code structure, and tooling only after a friction point has been identified, to determine whether the correct behavior was already owned somewhere.

Do not add telemetry, scoring infrastructure, or a new audit trail just to run the retro.

## Find intervention that matters

Separate necessary owner intervention from avoidable coordination.

Necessary intervention includes product decisions, new authority, genuinely ambiguous business intent, irreversible/high-cost actions, and decisions outside previously agreed scope.

Avoidable intervention includes reminders to finish already-authorized work, pointing an agent at implementation it should reasonably discover, correcting a clearly documented invariant, asking for an obvious relevant check, repeated review loops that add no new evidence, and avoidable CI failures that a supported local check should have caught.

Look for patterns across the evidence window. A single weak Run is not enough reason to change repository policy unless it exposes a clear deterministic defect.

## Trace each repeated friction point to its owner

Classify the cause before recommending a change:

- durable architecture, safety, authority, or completion ambiguity -> `AGENTS.md`;
- an existing repeatable procedure is unclear or ineffective -> its owning Skill;
- repeated specialist work has no existing procedural owner -> consider a new Skill;
- a mechanical check is repeatedly forgotten or reconstructed -> code, script, test, or CI;
- code or API structure itself causes repeated confusion -> simplify the implementation or interface;
- information is hard to discover -> improve naming or owned documentation;
- one-off model miss with an already-clear contract -> no repository change.

Prefer fixing the cause over instructing around it. Prefer deleting, consolidating, or clarifying an existing owner before adding another source of truth.

## Recommend conservatively

Return at most three improvements, ranked by expected reduction in future owner intervention or by correctness impact. Each recommendation must cite the repeated evidence that justifies it and name the owning mechanism to change.

`No change warranted` is a successful retro result.

Do not mutate repository instructions, Skills, code, CI, issues, releases, or deployment state unless the owner explicitly authorizes that follow-up work in the same request or later.

## Output

Keep the retro compact:

- evidence window reviewed;
- repeated avoidable intervention or friction, with concrete examples;
- likely owning cause;
- up to three recommended changes, or `No change warranted`;
- what should be observed in future real work to judge whether a change actually helped.

The primary outcome measure is whether equivalent future work reaches a correct, verified, mergeable result with less unnecessary owner intervention. Do not optimize for fewer messages, fewer Skills, or lower process count by themselves.
