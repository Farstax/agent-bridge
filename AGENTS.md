# Core Architecture Principle — Native CLI First

Agent Bridge coordinates capable native agent CLIs. It is **not** a competing agent runtime.

When designing, implementing, or reviewing changes:

- Prefer provider-native capabilities for reasoning, tools, skills, subagents, and provider-specific execution.
- Keep Agent Bridge focused on cross-provider or durable coordination the CLIs cannot provide themselves: Run identity and ownership, routing/failover, continuation and restart recovery, cancellation/fencing, delivery, idempotency, and hard mechanical safety boundaries.
- Before adding Bridge-side orchestration, scheduling, agent hierarchies, tool frameworks, or execution logic, ask: **can the native CLI already do this?**
- If yes, expose, configure, or stitch together that native capability instead of duplicating it.
- New abstractions should make native agents more capable together, not make Agent Bridge a competing agent framework.
- Provider-native fan-out (subagents, teams, parallel tool calls) is the active provider agent's planning decision within its own Run, not Bridge orchestration. Use it only for genuinely independent scopes or questions; prefer useful independent coverage over worker count, avoid several workers inspecting the same scope without a specific reason, and weigh the cost of reconciling outputs before adding more of them.
- Before asking a model to synthesize several native subagent outputs, reduce them first with ordinary deterministic tools/code where practical — deduplicate exact findings, normalize structured fields, sort/group evidence, compare identifiers/paths/SHAs, drop malformed or irrelevant records, compute mechanical results — rather than routing raw output straight into another model call.

Add Bridge-owned machinery only when a concrete cross-provider, durability, lifecycle, or safety requirement cannot be met at the native CLI boundary.

---

# Platform Infrastructure Ownership

| Component | Host | Managed by | Keys/Access |
|---|---|---|---|
| Control plane + onboarding frontend | Aruba VPS | User (manual deploy) | `~/.secrets/ARUBA_API_KEY.TXT` + `ARUBA_API_SECRET.TXT` |
| Cloudflare tunnel (exposes control plane) | Aruba VPS | `cloudflared` on Aruba | tunnel URL changes on restart unless named tunnel |
| Customer workspace droplets | DigitalOcean | Appliance code in `agent-bridge-platform` | `~/.secrets/DIGITALOCEAN_API_TOKEN.TXT` |
| Agent bridge bots (Claude, Codex, Agy) | This machine (`content-crawler`) | systemd user units | `~/.ssh/id_ed25519` for GitHub |

Claude (this agent) can directly manage DigitalOcean droplets via the API token.
Claude cannot SSH to Aruba — the user must pull and restart the control plane there manually.

---

# Development Practice — Red-Green-Refactor TDD

**All implementation work uses red-green-refactor TDD. No exceptions.**

The full TDD rules are in `CLAUDE.md`. The critical agent-specific requirements are:

## Provider continuation and fallback invariant

Provider-native delegated work and background processes belong to the owning
provider Run. The main conversational agent remains responsible for exactly
one user-visible terminal closure. If a provider is exhausted during
continuation, the admitted logical turn must recover through the existing
durable queue/capacity-fallback/fresh-session handoff path or close with one
concrete blocker. Fallback transfers responsibility for the logical turn; it
does not migrate or resume provider-native subagents in another provider.
Regression tests should cover meaningful interactions between lifecycle
boundaries, rather than only testing continuation and capacity fallback in
isolation.

## Verification — mandatory each cycle

Use focused red/green locally; exact-head GitHub CI owns the required full-suite regression gate.

```bash
# Step 1: write the regression/acceptance test, then confirm focused red
npm test -- <focused-test-file-or-pattern>

# Step 2: write the minimum implementation, then confirm focused green
npm test -- <focused-test-file-or-pattern>
```

The red command must exercise the smallest deterministic test set that proves the requested behaviour and show the new test failing for the expected reason before implementation. The green command must rerun that same focused set plus directly affected boundary tests. Widen local verification only when the touched boundary or risk warrants it.

Do not rerun the full suite locally by default. Run local `npm test` only when the change is intentionally broad/global, exact-head GitHub CI is unavailable, or a CI/review failure requires full-suite reproduction.

Before merge, the current PR head must have a successful full `npm test` run in GitHub `CI` plus the repository's other required exact-head checks. CI evidence belongs to the exact head SHA; any code change invalidates it and requires fresh CI.

Independent review must not duplicate a current green full-suite run without a concrete investigation reason. Reviewers should inspect the exact current head, run focused tests needed to investigate findings, and rely on exact-head GitHub CI for the full regression proof. If review repairs change the head, wait for fresh exact-head CI rather than reproducing the full suite locally first.

Do not skip the red verification. If you cannot see the focused test failing before writing implementation, the test is not testing the intended change.

## Provider qualification and CLI drift

Provider qualification is a bounded compatibility suite for external provider
CLI contracts. It is not a model-intelligence benchmark or an end-to-end test
of Agent Bridge. The executable Agent Bridge actually invokes, and its observed
supported `--version` output, are authoritative for runtime health, upgrades,
qualification lookup, and persisted evidence. Package-manager metadata may
discover or install updates, but it is never proof of the runtime version; a
package/PATH/runtime disagreement must be diagnosed explicitly.

Qualification should cover concrete provider behavior Agent Bridge relies on:
startup and version reporting, invocation and output envelopes, session/resume
identity, error classification, and provider-specific continuation/background
protocols where applicable. Keep live checks bounded, deterministic,
non-destructive, and safe for a controlled authenticated environment. Telegram,
Discord, queues, lanes, typing indicators, persistence, restart recovery,
stop/interrupt fencing, routing, fallback policy, and final message delivery
belong in deterministic repository tests.

When production code starts relying on a new provider-specific CLI behavior,
ask whether a provider release changing it would be detected before users hit
the regression. If the contract can be checked reliably, update qualification;
otherwise document why and retain deterministic fixtures rather than adding a
flaky live check. Production provider regressions should normally become
permanent qualification fixtures when they expose a reusable CLI assumption.

Qualification is normally triggered when the actual runtime version changes,
the provider contract version changes, or an operator explicitly requests it;
do not run live provider qualification on ordinary CI builds. After upgrades,
re-read the active executable, verify that the update affected that executable,
qualify that exact observed version, and persist evidence keyed by provider,
runtime version, and provider-contract version. Cached evidence for another
runtime version is stale regardless of package-manager state.

## Commit discipline — required

Tests and implementation are always **separate commits**:

```
commit 1: test: failing tests for <feature>     ← red
commit 2: feat/fix: implementation              ← green
```

Never bundle test files and production code in the same commit. This is the most common TDD failure in agent-assisted development — it produces tests-alongside-code with no verifiable red state.

## Planning requirement

When executing or reviewing a plan, every phase that adds new behaviour must include an explicit red→green step: write the focused test, confirm red, commit the test-only state; implement the minimum change, confirm focused green, commit implementation; then push the final head and require exact-head GitHub CI and the other required checks before merge. If a plan instead mandates repeated local full-suite runs without a concrete risk reason, correct the plan before starting that phase.

---

# SDLC Skill Routing

Before planning, implementing, reviewing, or releasing software changes, read the relevant repository skill:

- `skills/requirements-to-acceptance/SKILL.md` for ambiguous, cross-functional, user-facing, or multi-module requests.
- `skills/risk-based-test-strategy/SKILL.md` when selecting test depth or reviewing coverage.
- `skills/red-green-refactor-tdd/SKILL.md` for features, bug fixes, refactors, and behaviour changes.
- `skills/release-readiness-review/SKILL.md` before declaring a change merge-ready, release-ready, or deployment-ready.

Skills supplement these repository invariants; they do not override them. If native skill discovery is unavailable, read the relevant `SKILL.md` directly.

# Simplified Approval and Release Workflow

Use a two-approval model for normal delivery. Safety is enforced by machine-verifiable invariants and fail-closed execution, not by requesting repeated human approval for every procedural step.

## Owner delivery shorthand — "ship it"

When the repository owner says **"ship it"** after the scope or solution has been agreed, treat that as authorization to execute the unchanged agreed scope end-to-end without asking for routine procedural confirmation again.

Unless the owner explicitly narrows or extends it, "ship it" means:

`issue → branch/PR → implementation + affected documentation → relevant validation → independent review → in-scope review repairs → required exact-head checks → merge → post-merge branch/worktree cleanup → compact completion report`

The directive itself is the explicit merge instruction for the resulting PR once the agreed scope is complete, the exact current head has satisfied required checks, and independent review has found no unresolved in-scope blocker. Do not pause to ask separately whether to create the issue, open the PR, apply review repairs, rerun invalidated checks, merge, or clean up the merged branch/worktree.

"Ship it" does **not** authorize scope expansion, unrelated refactoring, bypassing tests/checks/review, weakening repository invariants, or concealing a material blocker. Stop only when a genuinely new decision falls outside the agreed scope or an existing stop condition is triggered.

Production deployment, destructive operations, credential/permission mutation, and other separately protected operational actions are included only when they were explicitly part of the agreed scope and their repository authorization/qualification rules are satisfied. A code-delivery "ship it" must not be stretched into an unrequested production mutation.

Update documentation that the shipped change makes inaccurate or incomplete. Do not create documentation churn when documented behaviour did not change.

## Owner release shorthand — "release it"

When the repository owner says **"release it"**, treat that as authorization to qualify, publish, deploy, and verify the current `main` without another routine approval.

Unless the owner explicitly narrows or extends it, "release it" means:

`current main → release-delta review → release notes + release-facing documentation → existing exact-SHA qualification → publish existing qualified artifact → established deployment path → existing post-deploy verification → compact completion report`

Review the merged delta since the previous release for concrete integration, migration, compatibility, or operational blockers. Do not reopen already-reviewed implementation work without a concrete release risk.

Reuse existing GitHub Actions, release-artifact qualification, publication, deployment, rollback, and acceptance automation. Do not duplicate tests, builds, checksums, or rollout mechanics unless required evidence is missing or failing.

Release notes should summarize meaningful user- or operator-visible features, fixes, and operational changes rather than list commits. Update release-facing documentation when the combined release makes it inaccurate or incomplete; change-specific documentation belongs in the originating `ship it` work.

If the exact candidate SHA has the required green qualification evidence and no concrete release blocker remains, publish and deploy it through the established paths. If qualification or verification fails, follow the existing fail-closed deployment and rollback rules rather than weakening the release gate.

## Approval 1 — exact-head merge approval

One independent review approves one exact PR head SHA after required exact-head tests and checks pass. GitHub `CI` is the authoritative full-suite regression proof for that head; independent review adds code/contract scrutiny and focused investigation rather than another routine full-suite execution.

The implementer's job is to produce the strongest valid solution; the reviewer's job is adversarial, not confirmatory — actively look for reasons the exact head should not be accepted, including unmet acceptance criteria, wrong ownership, regressions, lifecycle/restart/concurrency defects, weak evidence, scope drift, or stale exact-head evidence, and reject when found. Route any rejection through the existing repair → reverify → re-review path (see "Owner delivery shorthand" above) and replan when the finding invalidates the agreed scope; do not impose a fixed retry count.

Before merge approval, agents may perform without additional approval:

- implementation and review repairs in an isolated branch or worktree;
- focused tests and risk-justified typecheck, build, lint, syntax and diff checks;
- CI reruns and exact-head artifact generation;
- read-only inspection and evidence collection;
- offline fixture validation, copied-database migration and rollback simulation;
- artifact, manifest, provenance and helper-identity verification;
- publication of evidence and review findings.

A head change invalidates the approval and prior exact-head CI evidence. Fresh required checks must complete for the new head. Merge still requires an explicit merge instruction unless an already-authorised merge automation is operating within its exact-head contract.

## Owner-authorized exact-release deployment

After merge, automation must produce one release qualification record bound to the exact environment and containing at least:

- main commit and tree;
- artifact name, builder workflow/run and archive SHA-256;
- manifest, package-lock, migration-helper and rollout-helper identities;
- source and target database schemas;
- copied-fixture cohort and offline evidence SHA-256;
- integrity, foreign-key and full-row queue/claim/run/lock preservation results;
- rollback simulation and byte-exact restoration results;
- current production preflight identity and state.

An explicit deployment instruction from the repository owner authorizes deployment of the resolved exact target. Do not add a second approval boundary. The owner-request path automatically materializes the target-bound authorization record, then authorizes the complete guarded operation described by that record: immutable staging, containment, verified backup, migration, atomic pointer switch, restart and post-start verification. Do not request routine approval again between successful phases.

The legacy exact-release approval file remains accepted while callers transition to the owner-request input. It is a compatibility input, not an additional approval step after an authenticated owner request.

## Exception-only stops

Stop and require manual review only when an approved invariant changes or the result is ambiguous, including:

- target commit, artifact, helper, config, host or environment identity differs from the qualification record;
- production state has materially changed since preflight;
- service containment cannot be proven, or the contained offline reconciliation cannot complete transactionally;
- integrity, provenance, preservation, containment or rollback checks fail;
- a failure occurs after services may have accepted writes;
- rollback safety or final active state cannot be proven;
- the authorisation has expired or its exact scope cannot be established.

Do not create new approval gates merely because a verification step exists. Verification should be automatic and reusable. A successful normal path is:

`BUILD → QUALIFIED → OWNER REQUEST AUTHORIZED → GUARDED ROLLOUT → VERIFIED`

Any failed invariant moves to:

`STOPPED — MANUAL REVIEW REQUIRED`

## Actions that do not need separate approval

Unless they mutate production or cross another explicit repository boundary, do not ask for separate permission for:

- read-only production probes;
- demonstrably read-only fixture capture;
- artifact download and verification;
- offline work on disposable copies;
- evidence generation or publication;
- immutable release-directory creation that does not alter active pointers or services;
- repeating unchanged qualification checks.

Avoid approval inflation, repeated restatement of already-proven evidence and token-heavy gate narration. Report only material changes, blockers, exact identities and the next decision required.

# Review-Derived Engineering Invariants

These rules address recurring defects found during independent review. A passing suite does not override a known contract, lifecycle, wiring, or deployment violation.

## Define the observable contract before editing

Before implementation:

1. Restate the intended outcome.
2. Record material assumptions, constraints, and explicit non-goals.
3. Define binary acceptance criteria observable outside the implementation.
4. Name the verification that proves each criterion.

Ask for clarification only when a missing answer makes a reasonable implementation unsafe. Otherwise, state the assumption and continue.

## Write implementation-ready issues

An issue should let another capable agent understand **what outcome is wanted, why it matters, what currently owns the behavior, what must remain unchanged, and how completion will be proven** without reconstructing the originating conversation.

Write the issue for the size and risk of the change. A small defect may need only `Outcome`, `Current behavior / root cause`, `Smallest implementation`, `Acceptance`, and `Validation`. A larger feature, operational change, or spike should use the fuller structure below when those sections add real implementation value. Do not inflate a narrow fix into a design document merely to fill headings.

Prefer this order:

1. **Executive summary / Outcome** — state the user-visible, developer-visible, or operator-visible result first. Say what changes and, when useful, what deliberately does not change.
2. **Why this matters** — explain the concrete friction, defect, risk, cost, or capability gap. Avoid generic trend language unless it directly supports the decision.
3. **Current state / ownership** — identify the existing implementation, owner, paths, commands, state, or contract an implementer must inspect. Distinguish verified current facts from proposed design.
4. **Desired behavior / contract** — describe important flows and invariants concretely. Use examples or small diagrams when they remove ambiguity.
5. **Smallest implementation** — point to the existing owner to extend and explicitly discourage unnecessary parallel abstractions. Keep implementation guidance high-level enough to allow better code-local choices after inspection.
6. **Failure behavior / edge cases** — include only cases that materially affect correctness, idempotency, isolation, recovery, security, or user/operator experience. State the intended outcome for each important failure rather than merely listing risks.
7. **Non-goals** — name tempting adjacent work that is explicitly outside scope. Use this to prevent scope creep, not to list every conceivable future feature.
8. **Acceptance criteria** — make completion observable and testable. Cover the main outcome, compatibility/invariants, meaningful failures, and required repository checks. Avoid restating implementation steps as acceptance criteria.
9. **Regression / validation guidance** — specify the authoritative boundaries that need evidence. Prefer deterministic tests and existing repository qualification paths; do not require live infrastructure unless the change actually crosses that boundary.
10. **Rollout / operational impact** — include only when deployment, migration, systemd, infrastructure, credentials, persistent data, or production behavior changes. State activation and rollback expectations proportionally.
11. **Prerequisites / related work / successors** — link only dependencies or follow-ups that materially affect sequencing or scope. Do not manufacture child issues to make the issue look complete.
12. **Agent pickup note** — finish complex issues with the one or two architectural/product constraints most likely to be lost during implementation, especially the simplification boundary.

For a **spike**, additionally state the hypothesis/question, evidence to collect, decision criteria, deliverables, and explicit stop/go outcomes. A spike should end in a decision or evidence package, not quietly become a production migration.

Issue-writing rules:

- Assign exactly one primary work-type label to every new issue: `type:bug`, `type:feature`, `type:marketing`, `type:research`, `type:maintenance`, or `type:docs`. Classify by **why the issue exists**, not by every file it may touch.
- Add secondary labels only when they materially improve filtering: `security`; `area:provider`, `area:runtime`, `area:worker`, `area:memory`, `area:control-plane`, `area:appliance`, `area:infrastructure`, or `area:gtm`; `status:deferred` or `status:blocked`; and exceptional helpers such as `good first issue`, `breaking-change`, or `priority:high`. Do not require an area label and do not create low/medium/high priority tiers by default.
- Lead with the intended outcome, not a chronology of prior discussion.
- Prefer one vertically useful issue over a chain of phase issues unless independently valuable boundaries genuinely require splitting.
- Reuse the current owner wherever possible; identify concrete evidence before proposing a new service, queue, schema, framework, or abstraction.
- Include exact issue/PR/commit/path identifiers only when verified. Treat changing external facts, versions, prices, provider behavior, and release state as facts to revalidate at implementation time.
- Keep alternatives only when they explain a material decision. Do not preserve abandoned designs as parallel requirements.
- Make non-goals and acceptance criteria consistent with the smallest implementation. If acceptance implicitly requires a broader architecture than the stated outcome, simplify before filing.
- State security, isolation, idempotency, restart, rollback, or data-preservation requirements only where the change touches those boundaries; do not copy a generic checklist into every issue.
- Do not prescribe low-level code structure that has not been verified against the current repository. Point agents to the likely owner and require them to inspect the exact current implementation first.
- When current behavior is already correct in sibling paths, explicitly say those paths must remain unchanged rather than asking the implementation to redesign them.
- Use references to give an agent primary evidence or nearby repository context, not to create a bibliography.

A good issue is **complete enough to implement without the originating conversation, but no larger than the decision being made**.

## Write review-ready pull requests

A pull request should let a reviewer — including an independent contributor or reviewer with no access to the originating agent conversation — understand **why the change exists, what the exact diff is intended to do, what it deliberately leaves alone, and what evidence makes the current head reviewable**.

Keep the body proportional. A small documentation or one-line defect fix can be brief; a lifecycle, persistence, security, provider-contract, release, or deployment change needs enough context to review the changed boundary safely. Do not paste the whole issue into the PR.

A useful PR body normally contains:

1. **Summary / Outcome** — the behavior delivered by this diff, in concrete terms.
2. **Why / Root cause** — for fixes, identify the reproduced cause; for features, identify the current gap. Do not present a hypothesis as a confirmed root cause.
3. **Scope and non-goals** — call out important sibling behavior that remains unchanged and any tempting adjacent work intentionally excluded.
4. **Implementation / contract** — only where needed, explain the important ownership boundary, flow, migration, lifecycle, or invariant. Prefer what a reviewer needs to reason about the diff over a file-by-file narration.
5. **TDD / validation evidence** — report the red evidence and green verification required by this repository, plus the checks actually run and their outcomes. Distinguish focused local results from exact-head CI; use exact-head GitHub `CI` as the authoritative full-suite proof and never claim checks that have not completed.
6. **Rollout impact** — include the repository-required `Rollout impact: none` or `Rollout impact: required — included in this PR`, with activation/rollback detail where the changed boundary requires it.
7. **Issue relationship** — use `Closes #N` only when this PR fully satisfies that issue. Use `Related to #N` when it is partial, exploratory, or prerequisite work.

PR-writing rules:

- Write the title as the outcome, not an internal implementation detail.
- Describe the **current head**, not the chronology of how the branch evolved. After review repairs or scope changes, update stale claims, test counts, non-goals, rollout notes, and issue-closing language.
- Preserve meaningful red/green commit evidence where required, but do not make the PR body brittle by enumerating every intermediate commit.
- State what was tested and, when material, what was not tested or remains a residual risk. Do not hide missing live/infrastructure verification behind generic wording such as “all checks pass.”
- Do not attach credentials, tokens, private host details, OAuth URLs, copied production data, or other secrets to a PR. Independent agent contributions must be reviewable from repository/public evidence without private conversational context.
- Do not include speculative successors unless they clarify why something is intentionally out of scope. Prefer the linked issue as the canonical design record for larger work.
- Avoid file-by-file summaries that merely restate the diff. Explain decisions, contracts, and evidence a reviewer cannot infer cheaply from code.
- A PR that changes behavior must include corresponding regression evidence at the affected boundary; a passing unrelated suite is not a substitute.
- Before requesting review or merge, inspect the final diff for unrelated changes and make the PR description agree with the final scope.

For independent or agent-authored contributions, assume the reviewer has **no access to the agent's prior prompts, hidden reasoning, local scratch notes, private memory, or private environment**. Everything required to evaluate intent and evidence must be either in the repository, linked issue, PR body, or reproducible checks.

## Complete the production path

Trace every changed behaviour through its required path:

`input → validation → state owner → side effect → persistence → runtime consumer → status projection → user-visible confirmation`

A helper, parser, repository method, DTO, endpoint, UI component, or unit test alone is not a completed feature. Each externally exposed slice must be vertically complete. Incomplete infrastructure may merge only when existing public behaviour is preserved or the new path is explicitly disabled behind a safe flag.

## Assess rollout impact

Every PR must include either `Rollout impact: none` or `Rollout impact: required — included in this PR`.

Mark it required only when the change affects release contents, systemd units, database migrations, filesystem paths or permissions, runtime configuration, startup, acceptance, or rollback.

## Use authoritative state and verify postconditions

Identify the authoritative source for every status or decision. Do not infer authentication from files when the provider can report it, Git state from model output, service state from an attempted command, or deployment success from intended actions.

After mutation, read back the protected postcondition:

- configuration → persisted value
- authentication → provider verdict
- repository state → Git
- process or service state → runtime supervisor
- deployment → exact artifact or commit SHA and health signal
- rollback → equality with the protected baseline

Keep status and probe surfaces read-only. Reconciliation or repair must be a separate explicit mutation. Label evidence as real, disposable, simulated, or inferred; never present inference as live verification.

## Model lifecycle, races, and recovery

For queues, jobs, migrations, credentials, releases, processes, or other lifecycle work, define states, transition owners, terminal states, retry and replay behaviour, restart behaviour, timeout and cancellation behaviour, stale-event handling, and rollback ownership before coding.

Terminal states must not be overwritten. Side-effect ownership must be recorded immediately. Cleanup and rollback must be retry-safe, preserve the original failure, retain enough state to resume after interruption, and restore every state dimension used to detect change.

Test success, each material failure boundary, retry or replay, restart, cancellation, timeout, and plausible concurrent completion.

## Test the contract at the risk boundary

The red test must exercise the production boundary that could permit the defect and fail for the expected reason.

- Prefer observable behaviour, persisted state, emitted events, authoritative status, and external-call assertions over implementation details.
- Prefer real implementations or focused fakes over broad mocks.
- Do not copy production parsers, schemas, state transitions, or decision logic into the test oracle.
- A helper-only test is insufficient when correctness depends on its caller, runtime wiring, persistence, process environment, or user-visible projection.
- Never skip, delete, weaken, or rewrite unrelated tests merely to make verification pass.

Match verification to the highest-risk boundary affected. Persistence, migrations, queues, authentication, permissions, external APIs, cross-module contracts, and operational changes require boundary-level checks; critical user paths require end-to-end or realistic manual verification.

## Preserve compatibility, explicit intent, and sibling behaviour

Before changing defaults or semantics, record and test existing behaviour for default, explicitly configured, legacy or omitted, unavailable dependency, and unsupported cases.

Parse explicit slash commands and structured controls before forced modes, defaults, routing, keywords, or heuristics. Explicit user intent must not be displaced by low-confidence inference; ambiguous input should clarify or fail safely.

Audit all sibling entry points, roles, providers, modes, optional services, install forms, transports, and environments. Record deliberate exclusions rather than silently fixing only the nearest variant.

## Diagnose first and keep changes coherent

For defects, CI failures, or review repairs, identify the smallest reproducing command, describe the observed failure, and state the likely root cause before editing. Preserve useful work already present and make the smallest correction that fixes the root cause without weakening the approved contract.

Implement one coherent slice at a time. Avoid unrelated cleanup, cosmetic rewrites, import churn, broad renames, and abstractions for hypothetical future use. Keep the repository buildable after each slice and commits small enough to review and roll back safely.

## Verify the deployed environment and documentation

When relevant, test clean-shell environment loading, missing or malformed environment files, closed stdin, non-default paths, runtime user and permissions, systemd install/enable/restart/health behaviour, install variants, and actual service topology. Process probes must be non-interactive, bounded by a timeout, and check exit status.

Update colocated documentation when public behaviour, configuration, commands, service operation, recovery, onboarding, or architecture changes. Add or update an ADR when a durable architectural decision or ownership boundary changes. Documentation never replaces tests, runtime safeguards, rollback support, or postcondition checks.

## Final evidence and regression audit

Before declaring work complete:

- inspect the final diff for unrelated scope
- search callers, aliases, entry points, and sibling implementations
- compare defaults, compatibility, security, and rollback behaviour
- run focused tests and risk-justified broader local tests/checks such as typecheck, architecture/static checks, build/manifest checks, and `git diff --check`; do not rerun the full suite locally by default
- verify successful required checks for the exact final commit SHA, using exact-head GitHub `CI` as the authoritative full-suite regression evidence, and account for all review threads and deferred items
- state what was tested locally, what exact-head CI proved, what was not tested, and the residual risk

## Continuous improvement and agent retrospectives

At the end of each non-trivial implementation, defect repair, migration, deployment, incident response, or independent review, perform a brief retrospective before declaring the work complete:

- what was missed, incorrect, unexpectedly difficult, or required rework
- which contract, boundary, lifecycle transition, assumption, test oracle, environment, or process allowed it
- whether the same pattern has appeared elsewhere in repository history
- whether an existing rule or skill should have prevented it
- the smallest systemic prevention: code safeguard, test, skill improvement, or agent rule

When evidence shows a recurring pattern, a high-impact systemic gap, or ambiguous or missing guidance, propose a concise update to this file. Add it in the same PR only when directly related and still reviewable; otherwise open a follow-up documentation-only PR.

Self-improvement changes must:

- be grounded in concrete repository evidence, not style preferences or one-off mistakes
- be durable, actionable, and verifiable
- generalize across future work without overfitting one incident
- avoid duplicating or conflicting with existing rules or skills; consolidate instead
- preserve human review: never silently edit `AGENTS.md` on `main`
- remove or revise stale rules when the codebase or architecture changes

Include the retrospective result in final evidence: `no new systemic pattern`, `existing rule covers it`, or a link to the proposed `AGENTS.md` or skill follow-up. A retrospective is required, but an `AGENTS.md` change is not: update rules only when the evidence meets the criteria above.

---

# Worktree and Branch Isolation

For substantial changes or complex features, use the `git-sandbox` skill to isolate execution environments. Do not modify the main workspace directly if worktree isolation is requested.

## Post-merge cleanup — mandatory

A PR is not operationally complete merely because GitHub reports it merged. The agent that performs or confirms the merge owns cleanup before reporting the work complete.

After merge:

1. Verify the PR is actually merged and identify its head branch and any local worktree created for it.
2. Inspect the PR worktree for uncommitted or otherwise unpreserved work. If anything must be retained, stop cleanup and report the blocker; never force-delete unknown work.
3. From a different checkout, remove the merged PR worktree with `git worktree remove <path>`.
4. Delete the merged local feature branch with `git branch -d <branch>`. Use `-D` only after proving the branch is merged and no work needs preservation.
5. Delete the remote feature branch with `git push origin --delete <branch>` when it still exists. If repository automation already removed it, treat that as successful cleanup.
6. Run `git worktree prune`, then verify `git worktree list` and branch listings no longer contain the stale PR worktree or feature branch.

Never delete the default branch, protected/release branches, a branch explicitly requested to be retained, or a branch/worktree known to be in use by another active task. If cleanup cannot be completed safely, report the result as **merged, cleanup blocked** with the exact remaining branch/worktree and reason rather than calling the work complete.

---

# Persistent memory

Bridge-spawned agents receive `AGENT_BRIDGE_CONTEXT_COMMAND` when shared
project memory is available.

Before making architectural decisions or modifying important behaviour, use:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<short relevant query>"
```

When you learn a durable project fact, decision, bug fix, convention, or
recurring issue, write a guarded candidate with:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '{"type":"decision","scope":"project","text":"<concise memory>","confidence":0.8}'
```

Do not save secrets, API keys, passwords, transient logs, or private personal
information.

# Prompt optimization

The Telegram response style block in `wrapTelegramPrompt()` (`src/cli.ts`) was
produced by the standalone optimizer script. To re-run it and get a candidate
replacement block:

```bash
npx tsx scripts/optimize-prompt-loop.ts --passes 4
```

The script uses `agy --print` for all LLM calls (no API key required). Model is
whatever is active in `~/.gemini/antigravity-cli/settings.json`. The optimizer
never writes to `src/cli.ts`; it prints the winning block for manual review and
application.

Full methodology in `docs/prompt-optimization-loop-research.md`.

---

# Service Restart Safety

**Never trigger direct `sudo systemctl restart agent-bridge-<bot>` from within an active bot session.**

When a direct restart command runs inside a bot session, systemd sends SIGTERM
to the entire service control group, including the currently-running CLI
process. That kills the session issuing the restart before it can report the
result.

Approved restart paths:

1. From outside any active bot session, use direct restarts:

```bash
sudo systemctl restart agent-bridge-antigravity
sudo systemctl restart agent-bridge-codex
sudo systemctl restart agent-bridge-claude
```

2. From inside an active bot session, use the narrow safe restart helper. It
   sleeps for 5 seconds before restarting services, giving the bridge time to
   send the final Telegram reply:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

The helper must be root-owned and granted via a narrow sudoers rule for only
`/usr/local/sbin/restart-agent-bridge`. Do not grant `NOPASSWD: ALL` or raw
passwordless `systemctl`. Do not use the helper for destructive operations or
worker deploys that need drain semantics; worker restarts that may interrupt
active jobs still require the worker-specific drain flow.

If the bot becomes unresponsive after a bad restart, send `/reset` to the
affected bot on Telegram to clear any stale execution lock.

---

# CLI Effort Policy

Supported effort levels are `low`, `medium`, `high`, `xhigh`, and `max`;
default is `medium`. Users can change interactive bot effort with `/effort`.

- Codex: pass effort as `-c model_reasoning_effort="<level>"`
- Claude: pass effort as `--effort <level>`
- Antigravity/Agy: no separate effort CLI flag exists. Keep the setting visible
  as unsupported/no-op and use Agy model labels for low/high variants.

Worker jobs choose effort by task: scribe/read-only jobs use `medium`, while
`tdd_implementation` and `orchestrated_task` use `high`. Do not route Agy into
code-writing chains.

---

# Autonomous Worker Loop — invariants

When working on the worker lane (`src/index-worker.ts`, `src/jobExecutor*.ts`,
`src/handlers/`, `src/workspace.ts`, `src/prMergeGate.ts`, `src/workCallbacks.ts`):

- Implementation jobs run **only in per-job workspace clones** (`src/workspace.ts`),
  never in live checkouts or the worker's cwd. Workspace cleanup must stay
  restricted to `$WORKER_WORKSPACE_DIR`.
- The TDD handler enforces the red/green split mechanically: red commits stage
  test files only and the red run must fail; green commits must not touch test
  files and verification must pass. Do not weaken these guards. Configure local
  red/green verification around the focused affected tests; the merge gate and
  exact-head GitHub CI own the mandatory full-suite proof.
- The merge gate verifies head SHA and CI checks via `gh pr view` before any
  merge. Never add a merge path that skips it. Approvals stay pending on every
  blocked path, and every Telegram callback must be answered.
- Jobs with unregistered task types fail permanently — never leave them
  pending (head-of-line blocking).
- `cancelWorkJob` is final; complete/fail must not overwrite `cancelled`.
- Child processes in the worker use the async runner (`src/runCommandAsync.ts`)
  — no `execFileSync` in the polling process.
- New job-queue Telegram output: messages go through `sendTelegramMessage`,
  message edits through the entity-converting helper in `src/workCallbacks.ts`
  (raw `**`/backticks must not reach Telegram).

User guide: `docs/WORKER-GUIDE.md`. Phase 9 plan:
`docs/autonomous-agent-bridge-research.md`.

# Health bot conventions

- The dedicated health service runs through `src/index-health.ts` with `BridgeEngine` kind `health`, but its suggestion CLI must execute through the configured agent kind (`HEALTH_SUGGEST_BOT` / `HEALTH_CLI_BOT`) so invocation, parsing, timeouts, and Telegram rendering match Codex, Antigravity, or Claude behavior.
- Manual `/health` should return one combined report only. Persist plugin reports for `/status` context with `HealthBridgeBot.handleReport(..., { force: true, silent: true })`; do not also force-send each plugin report.
- `HEALTH_SUGGEST_*` is the documented health suggestion config family. `HEALTH_CLI_*` remains a compatibility alias.
- Health event runs use the fixed `health:report-only` authority scope. The event is evidence for investigation. It does not grant deploy, restart, credential, permission, or repository-mutation authority. The agent must follow this repository policy and the applicable Skill before taking any action.
- `HEALTH_EVENT_TOKEN` enables the authenticated scheduler-to-agent health event path. The health service fails closed for event execution when it is unset.

# Deployment contract

The Agent Bridge runtime/coding-agent account retains unrestricted passwordless
administrative sudo. This is a production invariant: deployment installation,
upgrade, recovery and cleanup must never replace, narrow, disable, remove or
otherwise invalidate that broader sudo rule. Deployment-specific helper entries
may be removed only when redundant; doing so must not alter unrelated sudoers
files or the account's broader access. For the current host, the effective rule
must remain:

```text
content-crawler ALL=(ALL:ALL) NOPASSWD: ALL
```

Before any sudoers change, identify the effective rule with `sudo -l`, back up
the affected file, validate the proposed result with `visudo -cf`, and prove
`sudo -k -n true` still succeeds for the runtime account, ensuring the probe
does not rely on a cached credential.

The sole normal production deployment command is:

```bash
sudo agent-bridge-deploy --release agent-bridge-<commit>.tar.gz --approval production-approval.json
```

For an authenticated repository-owner deployment request, use the automatic
authorization path instead:

```bash
sudo agent-bridge-deploy \
  --release agent-bridge-<commit>.tar.gz \
  --owner-request owner-deployment-request.json
```

The protected request file must be root-owned and mode `0600`, and must bind
the exact repository, repository owner, authenticated principal, request
reference, validity window and target commit. The deployer writes the
mode-`0600` target-bound approval record itself and continues through the
existing staging, guarded rollout and acceptance path.

The release archive is self-contained and carries the exact commit/tree
manifest, runtime, migration code and embedded CI qualification evidence. The
minimal approval binds only environment, target commit, release SHA-256,
approval reference and expiry. Do not introduce external evidence files,
secondary bundles, per-helper approval hashes or a second operator workflow.

`release-stage.py`, `release-activate.py`, `rollout-restore.py`,
`rollout-authorization.py` and `rollout-acceptance.py` are private deployer
internals. Install them root-owned and non-writable at their fixed
`/usr/local/libexec/agent-bridge-*` paths, remove any sudoers entries that
expose them directly, and do not document or invoke them as normal operator
commands. Only `agent-bridge-deploy` is the production sudoers entry.
