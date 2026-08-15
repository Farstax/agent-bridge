# 01 — Current Architecture (historical baseline)

> Historical snapshot. The Engineering Worker described below was removed
> after issue #347. Use [overview.md](overview.md) for current behaviour.

Status: historical architecture record. The current architecture is in `overview.md`.

This document describes behaviour and ownership that exist in the Agent Bridge OSS repository. Target-state role orchestration is documented separately and is not represented here as active merely because its prompt or persistence foundation exists.

## 1. System overview

Agent Bridge OSS is a TypeScript/Node runtime connecting Telegram and Discord surfaces to supported coding CLIs. The repository contains three main runtime capabilities:

| Capability | Entry points | Core owners |
|---|---|---|
| Companion layer | `src/index.ts`, `src/index-interactive.ts`, `src/index-discord-interactive.ts` | `src/engine.ts`, `src/cli.ts`, `src/interactiveBot.ts`, `src/workerFallback.ts`, provider runtimes |
| Engineering Worker | `src/index-worker.ts` | `src/workerBot.ts`, `src/jobExecutor.ts`, `src/jobExecutorLoop.ts`, `src/workCallbacks.ts`, `src/handlers/*` |
| Health and operations | `src/index-health.ts` | `src/health/*` |

The hosted control plane and appliance lifecycle live in the separate `agent-bridge-platform` repository. The OSS repository owns the bridge and worker runtime installed on an appliance; it does not own the platform database, API, UI, desired-configuration transport, or fleet deployment control plane.

Each runtime opens an explicitly configured SQLite database through the appropriate database boundary. Production services may use separate database paths by service role; the architecture must not assume one physical database file for every process.

## 2. Companion and provider execution

### Core orchestration

- `src/engine.ts` owns messaging update handling, command dispatch, conversation execution, fallback coordination, memory/context integration, event emission, and response delivery for companion surfaces.
- `src/cli.ts` provides provider-neutral invocation/result dispatch and thin adapters over the supervisor.
- `src/cliSupervisor.ts` is the sole child-process lifecycle owner. It owns process registration, argument and environment preparation, workspace-lock wrapping, timeouts and watches, cancellation, termination, and settlement.
- `src/providers/registry.ts` owns provider capabilities and policy metadata.
- `src/providers/codexRuntime.ts`, `claudeRuntime.ts`, and `antigravityRuntime.ts` own provider-specific invocation and parsing.
- `src/workerFallback.ts` owns cross-CLI companion fallback and conversation handoff.
- `src/worktreeLock.ts` and the supervisor/workspace boundaries protect shared Git worktrees from concurrent CLI mutation.

Provider identity does not grant lifecycle or mutation authority. Callers select a provider through configuration and policy; the supervisor remains provider-neutral.

### Messaging and rendering

- `src/telegram.ts`, `src/discord.ts`, `src/discord-gateway.ts`, and `src/platform.ts` own messaging API and platform boundaries.
- `src/markdownIR.ts`, `src/nativeLayout.ts`, `src/render.ts`, and `src/messageDelivery.ts` own the primary structured rendering path.
- Some worker-specific responses still use their existing formatting path; this does not create a second workflow or execution authority.

## 3. Engineering Worker

### Active worker lifecycle

`src/index-worker.ts` constructs the current handler map and starts the existing command surface and executor loop.

The active lifecycle is:

```text
work item or scheduled job
→ durable `work_jobs` record
→ claim/lease through the current repository and executor loop
→ handler selected by existing `task_type`
→ bounded CLI or Git/GitHub operation through injected owners
→ durable result, repair job, approval state, PR lifecycle, or terminal status
```

Current owners include:

- `src/workerBot.ts` — Telegram work-item, job, and status command surface;
- `src/jobExecutor.ts` and `src/jobExecutorLoop.ts` — claim, execute, retry/repair enqueue, cancellation, and terminal fencing;
- `src/workCallbacks.ts` — callback ownership and approval actions;
- `src/workspace.ts` — disposable implementation workspaces;
- `src/workerCliPolicy.ts` and `src/workerDispatch.ts` — current effective legacy CLI-chain policy and dispatch;
- `src/prMergeGate.ts` and PR lifecycle handlers — exact PR state, human merge authority, and related work-item completion;
- `src/handlers/featurePlan.ts`, `implementationPlan.ts`, `tddImplementation.ts`, `defectScan.ts`, `refactorScan.ts`, `orchestratedTask.ts`, `githubIssue.ts`, and PR handlers — existing task implementations.

Existing red/green TDD guards, disposable workspaces, queue/lease semantics, provider fallback, GitHub mutation helpers, and human merge gate remain authoritative.

### Role-orchestration foundation delivered through Slice 1

The Issue #159 foundation now contains:

- `src/agenticPromptContracts.ts` — versioned Technical Lead, Code Worker, and Documentation Steward prompt contracts, including pre-mutation decomposition review;
- `src/lifecycleSkillGuidance.ts` — deterministic extraction, validation, composition, and identity of canonical skill guidance;
- `src/implementationPlanQuality.ts` — comprehensive red-test, coverage, and target-path provenance gate;
- `prompts/worker/roles/*` — separate role/mode prompts;
- source-only compatibility prompts for current handlers;
- `src/agentRoles.ts` — the exact three-role domain, mode registry, bounded desired-assignment parser, and secret/content rejection;
- `src/repositories/roleAssignmentRepository.ts` — append-only desired assignment revisions behind `BridgeDb`;
- schema migration 3 — additive dormant role-assignment tables;
- `/chain` status projection — truthful desired assignment and effective legacy-chain reporting.

The current role-assignment state is deliberately dormant:

- a valid explicit assignment is persisted and reported as `configured_dormant`;
- `src/workerCliPolicy.ts` remains the effective worker provider policy;
- existing task types, handlers, and interactive fallback remain active and unchanged;
- no handler, job, or companion request reads role assignments to select a provider or model;
- capability resolution, permission profiles, requirements lifecycle, Documentation Steward execution, Technical Lead review phases, and role-native prompt dispatch are not active.

Desired state and effective state are therefore distinct. The status surface explicitly reports `Role routing: disabled` and the effective legacy interactive, code, and scribe chains.

## 4. Persistence

### Database boundary

- `src/db.ts` is the `BridgeDb` compatibility façade. It checks schema compatibility before normal operation, constructs repository owners, delegates existing public methods, and performs bounded non-schema maintenance.
- `src/db/schema.ts` owns schema versioning and the ordered migration registry. At Slice 1, `CURRENT_SCHEMA_VERSION` is `3`.
- `src/db/legacyBaselineMigration.ts` owns migration 1 and its historical compatibility repairs.
- `src/db/dropLegacyPromptOverridesMigration.ts` owns migration 2. It treats an absent prompt table as already retired, drops an empty table transactionally, and rejects unexpected rows without logging their content.
- `src/db/roleAssignmentsMigration.ts` owns migration 3. It adds `role_assignment_revisions` and `role_assignments`, validates exact columns, metadata, defaults, constraints, indexes, and the cascading foreign key inside the migration transaction, and fails closed without advancing `user_version` when a malformed lookalike exists. Strict production open and guarded rollout validation separately require a clean database-wide `foreign_key_check`.
- `openProductionDb()` remains strict: production services do not migrate automatically at startup.
- Issue #135 and the guarded rollout helper own production database inventory, backup, migration, validation, restart sequencing, rollback, and sentinel evidence.

### Repository ownership

SQL is owned by focused classes under `src/repositories/`, with `BridgeDb` retaining its compatibility façade. Current repositories own sessions, locks, settings, runs/events, worker queues and work items, memory, compaction, advisor records, conversation records, and dormant role-assignment revisions.

`pending_messages` remains the documented compatibility exception coupled to lock/lease ownership. New work must not add SQL to handlers, configuration, status, prompt loaders, AdvisorService, or GitHub helpers.

### Durable state

Durable state includes:

- provider sessions and settings;
- polling offsets;
- work items, jobs, approvals, plans, and GitHub links;
- run and event audit records;
- conversation turns and summaries;
- project memories;
- pending-message/lock state;
- desired dormant role-assignment revisions and child assignment rows.

The role tables store bounded scope, source, status, revision identity, CLI/model identifiers, selection labels, fallbacks, and timestamps. They do not store credentials, tokens, raw prompts, repository content, capability results, or permission profiles.

Events are an audit projection, not the authoritative worker lifecycle state. Work item/job records, leases, terminal fencing, approvals, and role revisions remain their respective authoritative records.

## 5. Memory and context

- `src/projectMemory.ts` and its repository own durable project memory.
- `/compact` and `src/compactSummary.ts` are the automatic durable-memory distillation path.
- `src/contextCommand.ts` provides context inspection and retains its documented read-only database exception.
- The removed post-turn memory extractor and its enablement flag are not part of the current architecture.

## 6. Current authority boundaries

| Concern | Current authoritative owner |
|---|---|
| Provider-specific invocation | `src/providers/*Runtime.ts` |
| Child-process lifecycle | `src/cliSupervisor.ts` |
| Shared worktree exclusion | `src/worktreeLock.ts` and workspace/supervisor integration |
| Worker queue, work items, approvals, and GitHub links | current work repository behind `BridgeDb` |
| Worker claim/lease/retry/cancellation | `src/jobExecutor.ts`, `src/jobExecutorLoop.ts`, repository state |
| Current effective worker CLI policy | `src/workerCliPolicy.ts` and `src/workerDispatch.ts` |
| Desired dormant role domain/config | `src/agentRoles.ts` and `src/config.ts` |
| Desired dormant role persistence | `src/repositories/roleAssignmentRepository.ts` behind `BridgeDb` |
| Desired/effective role status | `src/workerBot.ts` `/chain` projection |
| Implementation planning validation | `src/implementationPlanQuality.ts` |
| TDD red/green enforcement | `src/handlers/tddImplementation.ts` and current Git guards |
| Advisor invocation, fallback, redaction, and audit | `src/advisorService.ts` and advisor owners |
| Prompt and lifecycle-skill source | registered repository files and canonical skill loader |
| Database schema | `src/db/schema.ts` and numbered migration modules |
| GitHub issue/PR mutation | current GitHub handlers/helpers, never a model |
| Merge | existing human approval and `src/prMergeGate.ts` |
| Production migration/restart | Issue #135 guarded rollout path and human operator approval |

## 7. Verification surface

The repository uses Vitest, TypeScript typecheck, Architecture Lint, cleanup/static checks, rollout-helper qualification where applicable, and Git diff/exact-head CI evidence.

Test totals and file counts are deliberately not duplicated here because they are volatile. Exact counts, commands, skipped tests, and current head are recorded in the reviewed PR or deployment evidence.

Important test classes include:

- provider runtime and fallback compatibility;
- supervisor cancellation, timeout, and settlement;
- worktree isolation;
- worker queue, lease, callback, and handler lifecycle;
- TDD red/green Git boundaries;
- database migrations, strict production opening, repository ownership, restart persistence, idempotency, and rollback;
- rollout classification of schema 2 as migratable and schema 3 as current only when both role tables exist;
- secret-safe role parsing and persistence;
- dormant role status plus structural preservation of every existing handler route;
- AdvisorService budgets, fallback, evidence, redaction, and audit;
- prompt contract, lifecycle-skill, plan-quality, and compatibility wiring;
- PR lifecycle and human merge gating.

## 8. Known current gaps and planned owners

The following are not active current behaviour and remain owned by later Issue #159 child slices:

- model/capability discovery and deterministic role resolution;
- effective/applied role activation and routing;
- mode-specific permission enforcement;
- requirements validation and canonical issue revision lifecycle;
- bounded Technical Lead evidence tools and role-native planning;
- scan-candidate disposition and immutable execution packets;
- Documentation Steward authoring/validation execution lane;
- Technical Lead implementation/operations/readiness runtime phases;
- durable cross-phase audit, restart, compatibility, and rollout qualification beyond Slice 1 persistence;
- platform desired/effective role allocation and transport.

These capabilities must extend the current owners rather than introduce a new workflow engine, queue, supervisor, state store, provider stack, GitHub mutation path, merge path, or platform configuration transport.
