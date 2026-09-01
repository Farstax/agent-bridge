# Agent Bridge — Repository Instructions

## Architecture: native CLI first

Agent Bridge coordinates capable native agent CLIs; it is not a competing agent runtime.

- Prefer provider-native reasoning, tools, skills, subagents, and provider-specific execution.
- Bridge owns cross-provider or durable concerns the CLIs cannot: Run identity/ownership, routing/failover, restart reconciliation, cancellation/fencing, delivery, idempotency, and hard mechanical safety boundaries.
- Before adding Bridge-side orchestration, scheduling, agent hierarchies, tool frameworks, wrappers, daemons, or execution logic, ask whether a native CLI or existing Bridge capability already owns it.
- Add code for concrete durable-state, authorization, isolation, concurrency, lifecycle, external-protocol, or deterministic-safety boundaries. Otherwise prefer instructions/Skills or deletion.
- Keep Telegram, Discord, HTTP, CLI, and UI transports thin. Remove obsolete code/config/services/tests/docs when a simpler owner replaces them.
- Add an abstraction only for a concrete boundary or a second real use case.
- Provider-native fan-out is the active agent's decision inside its Run. Use it for genuinely independent scopes, not duplicate inspection. Deterministically reduce/deduplicate structured outputs before asking another model to synthesize them when practical.

## Technical invariants

### Repository-grounded implementation explanations

For questions about how this repository works or other implementation-specific behavior, inspect the relevant implementation source with the active provider's native repository/search/file tools before describing it. Prefer verified implementation over plausible inference. Treat native source inspection as the normal first step; use retained conversation context only to locate likely areas, not as evidence for current implementation. If the relevant source cannot be inspected, state that limitation instead of presenting an inferred implementation as verified.

### Repository-grounded implementation explanations

For questions about how this repository works or other implementation-specific behavior, inspect the relevant implementation source with the active provider's native repository/search/file tools before describing it. Prefer verified implementation over plausible inference. Treat native source inspection as the normal first step; use retained conversation context only to locate likely areas, not as evidence for current implementation. If the relevant source cannot be inspected, state that limitation instead of presenting an inferred implementation as verified.

### Provider-owned completion

Ordinary Claude and Agy Runs delegate provider-owned background/task completion to the provider CLI. Bridge owns the Run, lane, cancellation/process fence, fallback, delivery, and restart reconciliation; it must not persist or infer a second provider-task lifecycle. Codex remains unchanged until it exposes an equivalent native completion boundary. While a provider invocation is alive, messaging surfaces keep typing refreshed until it settles or is fenced.

### Provider qualification and CLI drift

The executable Bridge actually invokes and its observed supported `--version` output are authoritative. Package-manager metadata may discover/install updates but is not proof of the runtime version.

Qualification covers concrete provider contracts Bridge depends on: startup/version, invocation/output envelope, session/resume identity, error classification, and provider-native completion protocols where applicable. Keep live checks bounded, deterministic, non-destructive, and limited to contracts deterministic repository tests cannot prove.

Run provider qualification when the actual runtime version or provider contract changes, or when explicitly requested—not on ordinary CI. Evidence is keyed by provider, observed runtime version, and provider-contract version; evidence for another runtime version is stale.

## Engineering workflow and Skill ownership

Use repository instructions for durable architecture/safety and Skills for repeatable engineering operations.

- `skills/requirements-to-acceptance/SKILL.md` — outcome, affected boundaries, lightweight premortem, acceptance, verification.
- `skills/red-green-refactor-tdd/SKILL.md` — implementation and defect invariant sweep.
- `skills/release-readiness-review/SKILL.md` — authoritative `review it` adversarial review.
- `skills/delivery-directives/SKILL.md` — owner commands `ship it`, `review it`, `release it`, `deploy it`, `hotfix`.
- `skills/systematic-debugging/SKILL.md` — diagnosis when the cause is not established.
- `skills/git-sandbox/SKILL.md` — substantial isolated worktrees when useful.

Do not duplicate these procedures here.

### Requirements and issue quality

For a non-trivial change, establish before implementation:

- observable outcome and important non-goals;
- actor/resource/authority when relevant;
- only the affected state/runtime/delivery/external/authority surfaces;
- a lightweight premortem: **if this ships and causes a defect, what are the most plausible reasons?** Retain only risks that change scope, acceptance, affected surfaces, or evidence;
- observable acceptance criteria and the evidence that proves them.

Issues should be complete enough to implement without the originating conversation but no larger than the decision. Lead with outcome and current owner. Do not preserve abandoned designs or prescribe unverified low-level structure. Split work when pieces are independently valuable or have a real dependency, not to satisfy arbitrary size limits.

### TDD

All behavior changes use observed red-green-refactor:

1. narrow deterministic RED that fails for the expected reason;
2. smallest correct GREEN plus directly affected tests;
3. refactor only when useful while green.

Separate pushed RED/GREEN commits are optional. Do not create Git/CI choreography merely to prove TDD. Focused local validation owns iteration; exact-head GitHub CI owns the final full regression gate.

For bugs, name the violated invariant and check sibling callers/providers/modes/transports/install paths for the same defect class. Prefer one durable canonical regression at the consequential boundary.

### Pull requests

Use one coherent invariant/outcome per PR; do not use arbitrary LOC/file limits. A cross-cutting invariant may correctly touch many files.

Keep PRs draft during iterative implementation/review when practical. The PR body is an evidence index, not a second issue or engineering diary. It normally needs only:

- linked issue/outcome;
- concise behavioral delta and material non-goals;
- exact-head evidence identifiers;
- rollout/rollback information only when relevant;
- material residual risk, if any.

Do not repeat the issue, commit history, review prose, and CI narrative in multiple places.

### `review it`

`review it` is defined only by `release-readiness-review`. `ship it` delegates to it; do not maintain a second review checklist here.

Run it before expensive final qualification where practical. Prefer a fresh/context-isolated review execution. The reviewer starts from the issue/acceptance contract and exact candidate, independently restates intended outcome/authority, and tries to disprove readiness across the real journey, sibling invariant, production-shaped boundary, relevant transitions, and final consequential authority.

A review finding that requires mutation ends that review of the pinned head. Repair in implementation mode, run focused evidence, then start a fresh review of the new head.

### Exact-head CI and evidence reuse

A ready merge candidate must pass all required exact-head checks. A head change invalidates only evidence whose conclusion depends on the old SHA.

Evidence is a fact about a technical state, not a conversational phase. Reuse valid evidence for an unchanged SHA rather than rerunning/restating it merely because the workflow moved from implementation to review or release.

Current CI ownership:

- draft/intermediate PR states: focused/local evidence; superseded Actions work should be cancelled where safe;
- ready PR candidate: one authoritative exact-head PR qualification owns tests, typecheck, and architecture lint; specialized checks run only when their paths/boundaries trigger them;
- `main`: Release Artifact owns one complete tests + typecheck + architecture lint + build/manifest qualification and emits the immutable artifact used by release publication. A merged push may reuse the successful PR qualification only when automation proves the merged commit and PR candidate have identical Git trees and the source `verify` job succeeded. If that proof is absent or ambiguous, run the complete main/release gate.

Do not recreate a separate full-suite or artifact run for the same SHA unless it proves a distinct contract. A successful result from a different tree does not qualify the current head.

### Local qualification before pushing

During implementation, run focused local checks at the owning boundary. Before relying on hosted CI for a final ready candidate, `npm run qualify:local` may provide early deterministic evidence. The authoritative final result remains the exact-head hosted qualification. The local command runs the same pack hosted CI uses — full test suite, typecheck, architecture lint — via `scripts/qualify-local.sh`, which `.github/workflows/ci.yml` also calls, so local and hosted CI cannot silently drift. It needs no network access or provider credentials and produces no interactive prompts. Provider qualification, live-provider smoke tests, and other credential/network/host-service-dependent checks are out of scope for this pack; they fail/skip explicitly on their own opt-in triggers (see "Provider qualification and CLI drift" above).

## Boundary qualification triggers

Use the relevant evidence, not a universal checklist:

- persistent state/startup/provision/deploy/reconcile → select relevant fresh, existing-production, restart/reconcile, rollback, interruption/retry, and true second-run/no-op transitions;
- security/identity/credential/permission/account selection → trace `actor -> authentication -> selection -> durable state -> credential -> target -> operation` and prove final effective authority;
- external API/CLI/browser → use production-shaped contract evidence when mocks cannot prove the real request/protocol;
- timeout/network/concurrency → exercise hostile failure, cancellation, non-settling operations, retry/replay, or races as relevant;
- shared/provider/sibling implementation → sweep the violated invariant across sibling paths;
- runtime/install/systemd/PATH/env → verify the effective process environment/state, not only generated source text;
- expensive install/build/deploy/appliance → qualify against the smallest supported resource envelope when it affects correctness.

Tests should assert observable contracts rather than implementation shape. Do not duplicate production decision logic in test oracles, rely on arbitrary sleeps/retries as flake fixes, or leave resources/global state behind. Test topology should shrink when runtime/process topology shrinks.

## Owner directives

### `ship it`

After scope is agreed, `ship it` authorizes the unchanged code-delivery scope end to end:

`issue/requirements -> draft PR -> implementation/focused evidence -> review it -> repairs/re-review -> final candidate -> exact-head checks -> merge -> cleanup -> compact report`

It does not authorize scope expansion, bypassing gates, production deployment, destructive operations, or credential/permission mutation unless those were explicitly part of the approved scope and separately qualified.

Routine completion reports answer: **what changed, did it work, and do you need to do anything next?** Add material residual risk when present; omit internal process narration unless requested or needed to explain a blocker.

### `release it`

Qualify the merged delta since the previous release for concrete integration/migration/compatibility/operational blockers, then publish the already-qualified exact `main` artifact through the existing release workflow. Reuse exact-SHA qualification; do not rebuild or repeat checks without a concrete reason. Release publication does not authorize deployment.

### `deploy it`

Deploy the explicitly approved release identity through the existing guarded deployment path. Bind the exact release/tag/commit/artifact before mutation, use existing migration/rollback/health/acceptance automation, and fail closed when identity or verification cannot be proven. Deployment does not authorize publishing a new release.

### `hotfix`

Restore the confirmed production/release-blocking failure with the smallest safe change while preserving TDD, required checks, review, rollback, and supported deployment. Once stable, RCA identifies which prevention layer should reasonably have caught the defect: product/requirements, boundary selection, red test, invariant sweep, independent review, transition/release qualification, or observability. Update the owning instruction/skill only for a reusable lesson; do not add incident-specific ceremony by default.

## Production/release safety

### Host filesystem hygiene

When operating the host, leave disposable state created by the operation cleaned up when it is safe to identify and remove. Put transient clones, downloads, archives, diagnostics, generated files, scratch scripts, and similar work in appropriate temporary or lifecycle-owned locations, and remove them after successful or failed work once they are no longer needed.

Do not create unmanaged long-lived state when an existing lifecycle owner exists. Manage Agent Bridge releases, application revisions, logs, databases, retained conversation evidence, service state, and other lifecycle-owned data through their owning lifecycle and retention rules rather than ad-hoc deletion. Never delete unknown, active, dirty, protected, persistent, or user-owned state merely for tidiness. Automated cleanup must remain bounded to artifact classes with a proven ownership/safety contract; do not add a generic filesystem sweeper. The canonical host-administration contract is `docs/operations/host-administration.md`.

### GitHub CLI authentication

On the managed host, `gh` uses `GH_TOKEN` from `~/.secrets/GITHUB_TOKEN.TXT`, not an interactive OAuth login. Verify identity before GitHub mutation. Git SSH authentication is separate.

### Exact-release deployment

The Agent Bridge runtime/coding-agent account retains unrestricted passwordless administrative sudo; deployment changes must not narrow or remove that production invariant. Before sudoers changes, inspect effective rules, back up the affected file, validate with `visudo -cf`, and prove non-interactive sudo remains effective without cached credentials.

Normal production deployment command:

```bash
sudo agent-bridge-deploy --release agent-bridge-<commit>.tar.gz --approval production-approval.json
```

Authenticated owner-request deployment:

```bash
sudo agent-bridge-deploy --release agent-bridge-<commit>.tar.gz --owner-request owner-deployment-request.json
```

The owner request must be root-owned/mode `0600` and bind repository, owner, authenticated principal, reference, validity window, and target commit. The deployer derives the target-bound approval and owns immutable staging, containment, verified backup, migration, pointer switch, restart, acceptance, and rollback.

The release archive is self-contained and carries exact commit/tree manifest, runtime/migration code, and embedded qualification evidence. Do not add secondary evidence bundles or parallel operator workflows.

Private deployer helpers under `/usr/local/libexec/agent-bridge-*` stay root-owned/non-writable and are not direct sudo/operator interfaces. `agent-bridge-deploy` is the normal production sudo entry.

Stop for manual direction only when an approved invariant/identity changes or a protected result is ambiguous—for example target/artifact/helper/host mismatch, materially changed production state, unproven containment, failed integrity/provenance/preservation/rollback, writes accepted after a failure, or unprovable final active state. Do not turn successful verification steps into extra approvals.

### Service restart safety

Never run direct `sudo systemctl restart agent-bridge-<bot>` from inside that active bot session; systemd would kill the caller. From an active bot session use the narrow delayed helper:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

Direct restarts are for an external operator/session. Keep helper sudo narrow; do not replace broader runtime sudo policy or grant ad-hoc raw `systemctl` rules for this purpose.

### Health authority

Health events are evidence, not mutation authority. Health event Runs use `health:report-only`; they do not grant deploy/restart/credential/permission/repository mutation authority. `HEALTH_EVENT_TOKEN` is required for authenticated scheduler-to-agent event execution and the path fails closed when absent.

Health suggestions must execute through the configured agent/provider kind so invocation, parsing, and rendering use the same provider contract as normal Runs; the health service must not invent a parallel provider invocation path.

Manual `/health` returns one combined report; plugin reports may be persisted silently for status context rather than double-sent. `HEALTH_SUGGEST_*` is the documented suggestion config family; `HEALTH_CLI_*` remains compatibility-only.

### CLI effort

Supported effort levels: `low`, `medium`, `high`, `xhigh`, `max`; default `medium`. Codex uses `model_reasoning_effort`, Claude uses `--effort`; Agy has no separate effort flag and exposes the setting as unsupported/no-op.

## Worktree/branch cleanup

Use `git-sandbox` for substantial isolation when useful/requested. After merge, the merging agent owns safe cleanup: verify the PR merged, ensure no unpreserved work, remove its worktree, delete merged local/remote feature branches where safe, prune worktrees, and verify stale state is gone. Never force-delete unknown work or active/protected branches.

## Retained conversation context

When `AGENT_BRIDGE_CONTEXT_COMMAND` is available, use it only for read-only retrieval of retained exact conversation turns when earlier context matters:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --recent 20
"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>"
```

The helper does not create or mutate project memory. Durable repository rules, architecture decisions, and reusable engineering guidance belong in the repository's normal owned documentation, instructions, or Skills rather than a hidden generated-memory store. Never use conversation context to persist credentials, transient logs, or private personal information.

## Prompt optimization

`src/cli.ts` Telegram response-style candidates can be generated with:

```bash
npx tsx scripts/optimize-prompt-loop.ts --passes 4
```

The optimizer prints candidates only; it does not edit production source. See `docs/prompt-optimization-loop-research.md` for methodology.
