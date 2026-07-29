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

## Verification — mandatory each cycle

```bash
# Step 1: write tests, then confirm they fail
npm test   # new test(s) must appear as FAILING

# Step 2: write implementation, then confirm everything passes
npm test   # all tests must PASS
```

Do not skip the red verification. If you cannot see the test failing before writing implementation, the test is not testing anything useful.

## Commit discipline — required

Tests and implementation are always **separate commits**:

```
commit 1: test: failing tests for <feature>     ← red
commit 2: feat/fix: implementation              ← green
```

Never bundle test files and production code in the same commit. This is the most common TDD failure in agent-assisted development — it produces tests-alongside-code with no verifiable red state.

## Planning requirement

When executing or reviewing a plan, every phase that adds new behaviour must include an explicit red→green step. If a plan does not call out "commit tests first, confirm red, then implement", raise it before starting that phase.

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

## Approval 1 — exact-head merge approval

One independent review approves one exact PR head SHA after required tests and checks pass.

Before merge approval, agents may perform without additional approval:

- implementation and review repairs in an isolated branch or worktree;
- tests, typecheck, build, lint, syntax and diff checks;
- CI reruns and exact-head artifact generation;
- read-only inspection and evidence collection;
- offline fixture validation, copied-database migration and rollback simulation;
- artifact, manifest, provenance and helper-identity verification;
- publication of evidence and review findings.

A head change invalidates the approval. Merge still requires an explicit merge instruction unless an already-authorised merge automation is operating within its exact-head contract.

## Approval 2 — exact-release deployment approval

After merge, automation must produce one release qualification record bound to the exact environment and containing at least:

- main commit and tree;
- artifact name, builder workflow/run and archive SHA-256;
- manifest, package-lock, migration-helper and rollout-helper identities;
- source and target database schemas;
- copied-fixture cohort and offline evidence SHA-256;
- integrity, foreign-key and full-row queue/claim/run/lock preservation results;
- rollback simulation and byte-exact restoration results;
- current production preflight identity and state.

One explicit deployment approval authorises the complete guarded operation described by that record: immutable staging, containment, verified backup, migration, atomic pointer switch, restart and post-start verification. Do not request routine approval again between successful phases.

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

`BUILD → QUALIFIED → DEPLOYMENT APPROVED → GUARDED ROLLOUT → VERIFIED`

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

## Complete the production path

Trace every changed behaviour through its required path:

`input → validation → state owner → side effect → persistence → runtime consumer → status projection → user-visible confirmation`

A helper, parser, repository method, DTO, endpoint, UI component, or unit test alone is not a completed feature. Each externally exposed slice must be vertically complete. Incomplete infrastructure may merge only when existing public behaviour is preserved or the new path is explicitly disabled behind a safe flag.

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
- run focused tests, the relevant broader suite, typecheck, architecture or static checks, and `git diff --check`
- verify the exact final commit SHA and account for all review threads and deferred items
- state what was tested, what was not tested, and the residual risk

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
  files and verification must pass. Do not weaken these guards.
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
