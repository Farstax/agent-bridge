# Issue 347: turns, skills, runs, and provider-native orchestration

Status: research result for issue #347

Date: 2026-08-12

## Decision

Agent Bridge can become smaller around durable conversation evidence and
execution safety. The smaller model is viable, but this is a staged subtraction
programme. It is not a reason to delete the current worker in one change.

Keep these owners:

```text
surface-neutral Workstream
  -> append-only conversation turns
  -> provider-native session
  -> durable Run and continuation
  -> agent + AGENTS.md + Skills + tools
  -> provider-native subagents inside that Run
  -> Git/GitHub/external artifacts
```

Agent Bridge must continue to own process lifecycle, isolation, fencing,
restart reconciliation, cancellation, queue admission, Git safety, CI evidence,
human approvals, and artifact correlation. The provider agent should own task
decomposition and native subagent reasoning.

The current `work_items` and `work_jobs` model remains a compatibility and
unattended-work boundary for now. It should not grow into a second general
workflow engine. Future changes should reduce it to intake, execution attempts,
checkpoints, and external artifact references where the invariant cannot live in
a Run, an event receipt, or GitHub.

## Evidence basis

The audit used current `main` at `b1a55fad12ef19b0d344286074ab7ff3c7b6f6e3`,
the current source, tests, architecture records, and recent merged continuation
work. The main implementation owners are:

| Concern | Current evidence | Classification | Decision |
| --- | --- | --- | --- |
| Conversation identity | `src/repositories/conversationRepository.ts`, `src/engine.ts`, and the canonical-address issue #278 | small shared primitive | Keep as a surface-neutral Workstream/address. Do not attach repository, Task, provider, branch, PR, or job state. |
| Verbatim turns | `conversation_turns` in `src/db/legacyBaselineMigration.ts` and `ConversationRepository` | shipped | Make append-only turns the recoverable source. `/reset` remains an explicit user deletion command; routine compaction must stop deleting source history. |
| Provider sessions | `bridge_state`, provider runtimes, `src/workerFallback.ts`, and `docs/architecture/memory-and-handoff.md` | shipped | Keep provider-native session IDs for same-provider continuity. A session is not cross-provider memory. |
| Runs and events | `RunRepository`, `EventStore`, `src/events/reducer.ts`, and `BridgeDb.reconcileOrphanedRuns()` | shipped safety primitive | Keep a Run as the execution and restart unit. Events remain an audit projection until a separate evidence-backed event-sourcing change proves otherwise. |
| Continuation | `src/repositories/continuationRepository.ts`, `src/continuationRecovery.ts`, and merged PR #330 | shipped safety primitive | Keep the minimum waiting/runnable/running/terminal state, delivery checkpoint, deadline, and fence. Do not add a parallel Task or subagent table. |
| Child process ownership | `src/cliSupervisor.ts` | shipped safety primitive | Keep one supervisor, process-group cancellation, run markers, bounded liveness probes, and settlement. |
| Workspace isolation | `src/workspace.ts`, `src/workspaceLock.ts`, and `src/handlers/tddImplementation.ts` | shipped safety primitive | Keep disposable per-job clones and Git worktree locks for writable work. |
| Worker intake | `work_items` in `src/db/legacyBaselineMigration.ts`, `src/workerBot.ts` | shipped compatibility boundary | Reduce gradually to external intent/provenance. It is not a general durable Task lifecycle. |
| Worker execution | `work_jobs`, `src/jobExecutor.ts`, `src/jobExecutorLoop.ts` | shipped but over-specialised | Keep leases, retries, cancellation, idempotency, phase checkpoints, and notification correlation. Move workflow policy into Skills and shrink task-specific handlers over time. |
| Plans and approvals | `feature_plans`, `work_item_plans`, `approvals`, `src/implementationPlanQuality.ts`, `src/prMergeGate.ts` | shipped policy/safety boundary | Keep plan evidence and human merge/deploy gates. A plan is an artifact, not a second execution identity. |
| GitHub lifecycle | `github_links`, PR handlers, `src/prMergeGate.ts` | shipped external-artifact boundary | Keep provider-independent head/CI verification, merge authority, issue closure, and branch/workspace cleanup. |
| Skills and local policy | `skills/*`, `AGENTS.md`, worker prompt loaders, TDD guards | shipped workflow source | Make these the primary domain workflow. Runtime should load and enforce safety contracts, not encode every feature/defect/refactor sequence. |
| Provider-native subagents | provider capability metadata in `src/providers/registry.ts`; no general native-subagent lifecycle in current code | vision / qualify carefully | Keep subagents inside the owning Run. Add observation only for a provider behaviour with a reproducible qualification fixture. |
| Events without a turn | health scheduler and reports in `src/index-health.ts` and `src/health/*`; worker sources include `health`, `schedule`, and `github` | partial | Add only an idempotent receipt and result correlation before feeding the same agent + Skills path. |
| Project memory | `MemoryRepository`, FTS5, `projectMemory.ts`, issue #304 resolution fields | derived/pinned knowledge | Keep for cross-conversation facts that are intentionally promoted and searchable. It is not a second transcript and must retain source provenance. |
| Summaries | `compactConversation.ts`, `conversation_summaries`, `compactSummary.ts` | useful cache, unsafe authority | Keep as regenerable handoff/context acceleration. A summary must never justify destructive loss of the only source evidence. |

## Representative ship-it trace

The current successful engineering shape can be represented without a new
runtime framework:

1. A conversation produces the request and acceptance boundary. A work item or
   issue reference supplies durable provenance when work is unattended.
2. `AGENTS.md`, requirements guidance, TDD, risk, and release skills define the
   plan, red/green split, review loop, and merge conditions.
3. A planning agent reads the repository and identifies independent inspection
   work. Provider-native subagents may perform those read-only slices inside the
   same provider Run. The Bridge does not need a swarm scheduler.
4. Writable implementation runs in `prepareWorkspace()`'s disposable clone.
   `workspaceLock`, `cliSupervisor`, and run fencing protect the checkout and
   process tree.
5. Tests and exact-head CI provide deterministic evidence. The independent
   reviewer checks the exact head. A finding either causes a bounded repair and
   re-review, a stronger re-plan when the same ownership problem repeats, or a
   user decision when scope changes.
6. GitHub owns the PR artifact. `prMergeGate` verifies head and checks before
   human merge approval. Cleanup removes the branch and workspace after the
   external artifact is terminal.

The current `orchestrated_task` handler proves the safety pieces are real, but
also shows the remaining simplification opportunity: it stores a plan, advisor
checkpoint, phase data, one bounded debug retry, verification output, and PR
handoff in `work_jobs`. Those fields are useful execution checkpoints. The
feature/defect/refactor policy around them belongs in Skills and local policy,
not in a growing handler taxonomy.

## Memory and handoff experiment

### Fixture and method

I used a deterministic 240-turn engineering conversation fixture with decisions,
corrections, superseded branch names, a changed release pin, an approval rule,
and an unresolved replacement-workspace item. The fixture is deliberately small
enough to reproduce without a provider call. It compares:

* latest 20 exact turns;
* a compact summary plus latest 20 turns;
* latest 20 turns plus scoped lexical search over older turns, selecting the
  newest matching evidence.

Run `node scripts/research/issue-347-memory-benchmark.mjs` to reproduce the
fixture. The benchmark measures retrieval correctness for four queries, whether the
latest superseding fact is selected, prompt-size estimates at four characters per
token, and local retrieval/composition time. It does not claim provider-model
quality or network latency; those require a version-pinned provider evaluation.

### Result

| Strategy | Correct cases | Supersession result | Approx. prompt size | Local median / p95 |
| --- | ---: | --- | ---: | ---: |
| Recent 20 turns | 0/4 | Cannot see older decisions | 655 tokens | <0.001 ms / <0.001 ms |
| Summary + recent 20 | 4/4 | Correct in this fixture because the summary retained current values | 752 tokens | <0.001 ms / <0.001 ms |
| Recent 20 + scoped search | 3/4 with naive exact terms; 4/4 after latest-match query expansion | Selects the newest branch/pin evidence when the query is scoped | ~698 tokens | 0.402 ms / 0.499 ms |

The missed case with naive search was a query phrased as “current branch” while
the source turns said only “branch”. This is a retrieval-query limitation, not
evidence that the old turn was absent. It is why search must be agent-directed
and chronology-aware, with explicit supersession wording in prompts and tools.

The result supports a hybrid policy: retain searchable source turns, use bounded
recent turns for local detail, and use summaries as disposable handoff caches.
Summary-only handoff remains unsafe because a malformed or stale summary can
omit the reason for a decision or an earlier correction. Search-only handoff is
also insufficient without a bounded recent window because it can retrieve a
fact without its surrounding decision context.

### Memory decision

* Stop routine pruning of `conversation_turns` after compaction. Preserve the
  source rows or move them to an append-only archive with checksums and the same
  chat/workstream scope. `/reset` can remain an explicit user-requested clear.
* Keep `conversation_summaries` as cache rows with source range metadata. They
  can be regenerated, replaced, or discarded without changing correctness.
* Keep `project_memories` for promoted facts that must survive chat boundaries:
  accepted architecture/product decisions, durable user constraints, repository
  conventions, recurring operational facts, and unresolved long-lived TODOs.
  Require source turn and scope provenance. Do not promote routine progress,
  transient status, or a duplicate of searchable turns.
* Re-run the benchmark with real redacted conversations and each supported
  provider before changing context defaults. Record token cost, latency, missed
  decisions, temporal corrections, and failure handling per provider.

## Provider-native subagents and review convergence

The planner can identify safe parallel read-only work such as persistence,
runtime, and test inspection. Native subagents should remain children of the
provider session and owning Run. Agent Bridge needs only the Run marker, process
ownership, cancellation/fencing, and a provider observation result when the
provider leaves work active after the direct process exits.

Review is a convergence loop, not a fixed retry count:

* implementation defect: repair and re-review;
* repeated architecture or ownership finding: stop the executor and re-plan with
  a stronger model;
* new product scope or policy choice: ask the user.

The current `orchestrated_task` one-retry checkpoint is a useful safety bound for
that handler, but it must not become the universal review policy.

## Domain-neutral demonstrations

The same runtime model supports these bounded workflows without core runtime
changes:

| Domain | Policy package | Run output | Bridge-owned invariant |
| --- | --- | --- | --- |
| Software engineering | repository `AGENTS.md` + requirements/TDD/risk/release/ship-it Skills | tested branch, PR, CI evidence, human merge | isolated workspace, Git guards, exact-head checks, merge gate |
| Marketing or research | a local policy file plus a research/marketing Skill | sourced brief, campaign draft, or decision memo | turn provenance, provider session, output artifact, review/approval policy |
| Farstax operations | health/ticket/event receipt plus bounded operations Skill | diagnosis, evidence pack, or owner-approved remediation | authenticated event receipt, idempotency, Run correlation, cancellation, approval for mutation |

The second and third rows are architecture demonstrations, not shipped
integrations. Current health scheduling proves the event source and report
boundary, but it does not yet expose a generic event-to-Run ingress. That is a
small successor primitive, not a reason to add a workflow engine.

## Minimum unattended event record

An event that has no preceding turn needs only:

```text
event_id, source, event_kind, received_at, occurred_at,
idempotency_key, bounded_payload_or_artifact_ref,
authority/scope, status, run_id, result_ref, error_class
```

The receipt must be durable before work starts, reject duplicate keys, preserve
the original source reference, and allow replay after restart without creating a
second writable Run. Payloads should remain bounded and redacted; large logs and
reports belong in an external artifact with a hash.

## Task identity decision

Issue #284's first-class durable Task identity is not required for normal
conversation-driven delivery. Originating Workstream/turn plus Run(s),
continuation state, and Git/GitHub artifacts represent the current flow safely.

A separate identity becomes justified only when Agent Bridge explicitly accepts
work that outlives the originating conversation and must correlate multiple
independent Runs or external retries under one cancellation/authority boundary.
Examples would be a scheduled health incident that creates a diagnosis Run and a
later approved repair Run, or one external ticket whose provider session is
restarted several times. Until one of these is implemented, keep the event
receipt and Run correlation fields instead of creating a Task state machine.

## Successor changes

These are intentionally small and ordered by safety:

1. Add an append-only conversation archive/read path and change compaction to
   stop deleting source turns. Add a fixture that proves summary replacement
   cannot remove the source evidence.
2. Add scoped chronological turn search to the context command and provider
   handoff prompt. Re-run the redacted benchmark with current providers.
3. Extract neutral Run/continuation/lease primitives from worker handlers while
   preserving the current queue and merge gates. Do not remove worker handlers
   until the replacement owns restart, cancellation, fencing, and artifact tests.
4. Add a minimal authenticated, idempotent event-receipt boundary for one health
   scenario. Feed it into the same Skill-driven Run path and add replay/fencing
   tests.
5. Revisit Task identity only after a concrete multi-Run external workflow lands.

## Release and rollback assessment

This spike changes documentation only. It adds no schema, runtime, provider,
permission, or deployment behaviour. No production rollout is required. The
successor proposals that alter turn retention or event persistence will require
copied-database migration tests, rollback semantics, retention/space monitoring,
and exact-head CI before release.

## Residual risk

The memory benchmark is a deterministic fixture, not a statistically valid
provider comparison. It does not establish that a model will perform search or
supersession reasoning correctly. Provider-native subagent support also remains
qualification work because current registry metadata does not expose a durable
subagent observer. These limits are explicit reasons to stage the successors.

Retrospective: existing repository rules and issue #347 required evidence before
subtraction; no new systemic pattern was found in this documentation spike.
