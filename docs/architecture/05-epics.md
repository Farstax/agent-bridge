# 05 — Epic Breakdown & Implementation Roadmap (historical)

> Historical roadmap input. Current engineering work uses provider-native
> agents, repository instructions, and Skills through ordinary Runs.

Effort scale: S ≤ 300 LoC, M ≤ 1,000, L ≤ 2,500, XL > 2,500 (incl. tests). Every epic ships behind green suite + arch-lint. One epic per PR series; no cross-epic PRs.

## Epic 1 — OSS Boundaries (M)
- **Purpose:** Stop OSS/appliance bleed; make the open-source unit self-contained.
- **Architecture:** Config loader `src/config.ts` (kills 4-way duplication, G2); env namespace split; boundary contracts per ADR-006; per-surface token validation at startup.
- **Interfaces:** `loadBridgeConfig(env): BridgeConfig`; `WorkspaceBootstrap` + `Heartbeat` API types (spec only).
- **Acceptance:** all entry points import one config module (structural test); startup fails fast with a clear error when two surfaces share a token; appliance references documented, not imported.
- **Migration:** extract config first (pure refactor), then token validation.
- **Risks:** hidden env couplings in systemd units → inventory `/etc/default/*` before merging.
- **Dependencies:** none. **Order: 1st.**

## Epic 2 — Provider Adapter Layer (L)
- **Purpose:** One interface per CLI (ADR-001); fix fallback misclassification permanently (G6).
- **Architecture:** `src/providers/{codex,claude,antigravity,kimchi}.ts` + `registry.ts`; adapters wrap existing `cli.ts` functions initially; `classifyError()` per adapter replaces shared string matching; kimchi session race fixed via pre/post file-set diff.
- **Interfaces:** `ProviderAdapter { kind, capabilities, buildInvocation(req), parseResult(raw), resolveSession(ctx), classifyError(err), effortArgs(level), timeouts }`.
- **Acceptance:** characterization tests lock current arg-building/parsing per CLI before extraction; `cli.ts` shrinks below 400 lines; adding a mock 5th provider requires touching only `src/providers/` (structural test); "session not found" no longer triggers model fallback (regression test).
- **Migration:** strangler per provider: codex → claude → antigravity → kimchi.
- **Risks:** antigravity log-scraping quirks — keep its wrapper thick, don't normalize prematurely.
- **Dependencies:** Epic 1. **Order: 2nd.**

## Epic 3 — Companion Router (M)
- **Purpose:** Formalize intent routing + session continuity across CLI switches.
- **Architecture:** Extract routing decision (preference → capacity → chain) from `index-interactive.ts` loop into `src/router.ts`; unify with `workerFallback.ts` handoff preambles; worker rendering onto IR pipeline (G8).
- **Acceptance:** router unit-testable without Telegram; switch mid-conversation preserves context preamble (existing behaviour locked by test); worker output rendered via markdownIR behind flag.
- **Migration:** flag `WORKER_IR_RENDERER=1`, delete legacy regex path after burn-in.
- **Dependencies:** Epic 2 (capabilities inform routing). **Order: 4th.**

## Epic 4 — Worker Engine (L)
- **Purpose:** Harden job lifecycle; wire architectural intent into acceptance (user mandate).
- **Architecture:** jobExecutor emits lifecycle events (Epic 6 types); repair policy object per task_type; acceptance-criteria templates gain structural assertions (ADR-007); finish BridgeDb→repository delegation (G3).
- **Acceptance:** reducer-derived status == column status property test; `db.ts` < 300 lines, zero `prepare(` outside repositories (arch-lint); failed structural acceptance blocks PR creation in tdd handler.
- **Migration:** one repository per PR; dual-write events alongside status columns.
- **Dependencies:** Epic 6 event types (can land types first). **Order: 3rd (interleaved with 6).**

## Epic 5 — Workflow Skills (L)
- **Purpose:** Declarative workflows (ADR-003) for feature/bug/review/refactor/docs/security/release + dependency-upgrade and CI-repair.
- **Architecture:** `src/workflows/` declarations; `workflowEngine.ts` interpreter registered in the jobExecutor handler map; steps reference skill packs (`skills.ts`) and step executors (current handlers).
- **Acceptance:** tdd_implementation behaviour byte-identical when run via workflow engine (golden tests); new "documentation" workflow added purely as data in the test.
- **Migration:** wrap existing handlers as single-step workflows; migrate multi-step tdd last.
- **Dependencies:** Epics 4, 6. **Order: 6th.**

## Epic 6 — Durable Event Store (M)
- **Purpose:** Events become source of truth (ADR-002); the enabler for observability, repair analytics, and CDC-style consumers.
- **Architecture:** Extend `events/types.ts` with the 14 lifecycle events; jobExecutor + prLifecycle + prMergeGate emit; `reducer.ts` derives; in-process subscriber hook (`onEvent`) for telegramAdapter/metrics.
- **Acceptance:** replaying events for any job reproduces its final state; consistency test in CI; event write failure never blocks execution (existing EventStore swallow semantics preserved).
- **Dependencies:** none hard. **Order: 3rd (types) / continuous.**

## Epic 7 — Memory (M)
- **Purpose:** Seven memory kinds (workspace/repo/conversation/provider/decision/review/failure) per Phase 4 spec.
- **Architecture:** `project_memories` + `kind`, `scope_ref` columns; typed accessors in memoryRepository; capture hooks: review feedback → review memory, repair outcomes → failure memory, ADR-style records → decision memory; retrieval scoped by (kind, scope) into prompts via contextCommand.
- **Acceptance:** repair handler stores failure memory and the next plan for the same repo retrieves it (integration test); no unscoped memory leaks across repos (regression, extends e8b1bf4).
- **Dependencies:** Epic 4 hooks. **Order: 7th.**

## Epic 8 — Usage Exhaustion & Provider Fallback (M)
- **Purpose:** Reliable degradation: model → model → CLI → CLI with user-visible reasoning.
- **Architecture:** adapter `classifyError` (Epic 2) feeds a `FallbackPolicy` (per chat + per job type); cooldown ledger in settings so a provider isn't retried within its rate-limit window; Retry-After honored where surfaced.
- **Acceptance:** simulated 429/exhaustion walks the documented chain deterministically (table-driven tests); no fallback on non-capacity errors (the G6 regression class).
- **Dependencies:** Epic 2. **Order: 5th.**

## Epic 9 — Feedback Routing (M)
- **Purpose:** Close the loop: PR review comments and CI failures route back into repair jobs automatically.
- **Architecture:** extend prWatch: ReviewReceived/CIFailed events → repair job with feedback context (GitHub as truth per ADR-005); import/list-issues commands implemented via github sync job (fixes dead commands).
- **Acceptance:** synthetic review comment on an open worker PR produces a repair job carrying the comment; external issue imported appears in /features list.
- **Dependencies:** Epics 4, 6. **Order: 8th.**

## Epic 10 — Observability (S–M)
- **Purpose:** Correlated, queryable runtime truth.
- **Architecture:** structured log helper (component + runId/jobId); metrics derived from event store (job durations, repair rates, fallback counts); health bot plugin consuming them; /status deep view per job.
- **Acceptance:** given a jobId, one query yields full timeline; health plugin alerts on repair-rate spike (test with seeded events).
- **Dependencies:** Epic 6. **Order: 9th.**

## Epic 11 — Testing (S, continuous)
- **Purpose:** Enforce ADR-007 everywhere.
- **Architecture:** `test/acceptance/` per-epic harness; `scripts/arch-lint.sh` (vitest-in-src, raw SQL, layer imports); pre-commit + worker acceptance integration; golden/characterization test conventions documented.
- **Acceptance:** arch-lint red on seeded violations; CI runs acceptance layer separately.
- **Dependencies:** none. **Order: with Epic 1, then continuous.**

## Epic 12 — Documentation (S, continuous)
- **Purpose:** Docs as part of definition-of-done.
- **Architecture:** this docs/architecture set maintained; per-epic ADR updates; operator runbook (tokens, systemd, recovery); contributor guide (adding a provider, adding a workflow).
- **Acceptance:** each epic PR updates its ADR + roadmap status; runbook validated by fresh-install walkthrough.
- **Dependencies:** all. **Order: continuous.**

## Suggested implementation order

| Phase | Epics | Rationale |
|---|---|---|
| 0 (immediate) | G6 hotfix; dedicated appliance token | Live-defect class; ops collision |
| 1 | E1 + E11 | Foundations: config, boundaries, lint |
| 2 | E2 | Adapter layer unblocks 3, 5, 8 |
| 3 | E6 types + E4 | Event truth + worker hardening together |
| 4 | E3 + E8 | Router + fallback (capability-aware) |
| 5 | E5 | Workflow engine on stable substrate |
| 6 | E7 + E9 | Memory + feedback loops |
| 7 | E10 + E12 close-out | Observability, docs, production checklist |
