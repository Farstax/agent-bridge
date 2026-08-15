# Documentation Conformance Audit

Validated against: `main` at `23d06cfc3e098561ec21ce29880e60d1d146b7cc`.

Scope: documents under `docs/`, plus code and root documentation needed to determine runtime references.

## Method

This audit classifies each reviewed document by comparing it with current implementation touchpoints and the current architecture hierarchy.

Primary grounding files checked:

- `README.md`
- `AGENTS.md`
- `package.json`
- `src/index.ts`
- `src/index-health.ts`
- `src/cli.ts`
- `src/soul.ts`
- `src/messageDelivery.ts`
- `src/nativeLayout.ts`
- `src/events/*` references from architecture docs
- worker files referenced by `docs/WORKER-GUIDE.md` and architecture docs

Operational note: the chat GitHub connector can fetch files and mutate branches, but repository-wide traversal was not reliable in this environment. The local runtime also could not clone GitHub because outbound DNS failed. This audit therefore uses direct file reads for the known docs set and code-grounding files. Treat it as a conservative conformance baseline and run `find docs -type f | sort` in a local checkout before large-scale file moves.

## Executive findings

1. The repository already has the right documentation hierarchy: ADRs, architecture, roadmap, research, and archive.
2. The missing piece was a docs landing page that tells humans and coding agents which documents are authoritative.
3. `docs/soul.md` must not be archived as “just research.” It documents implemented runtime behavior, although runtime loading defaults to root `SOUL.md`, not `docs/soul.md`.
4. Several root research files are now implementation records or superseded pointers. They should not drive new work.
5. `docs/native-telegram-layout-spike.md` needs a follow-up status refresh because it says rich-message paths were retired, while production code still attempts `sendRichMessage` for table routes when available.
6. `docs/prompt-optimization-loop-research.md` remains useful because `AGENTS.md` points to it, but its earlier `src/agentMemory.ts` discussion is stale.

## Classification table

| Document | Runtime / code grounding | Classification | Recommendation |
|---|---|---|---|
| `docs/adr/ADR-001-oss-product-split.md` | Matches current product split docs and Epic 11. | authoritative | Keep. |
| `docs/adr/ADR-002-shared-runtime.md` | Matches Shared Runtime architecture and Epic 11 scope. | authoritative | Keep. |
| `docs/adr/ADR-003-capability-registry.md` | Matches minimal registry scope in Epic 11. | authoritative for planned work | Keep. |
| `docs/adr/ADR-004-engineering-worker-boundary.md` | Matches worker guide and architecture boundary. | authoritative | Keep. |
| `docs/architecture/overview.md` | Defines documentation hierarchy and product split. | authoritative | Keep; this is the top architecture entry. |
| `docs/architecture/companion-runtime.md` | Maps to Telegram/Discord conversational entry points. | authoritative architecture | Keep. |
| `docs/architecture/engineering-worker.md` | Maps to worker guide, worker queue, PR lifecycle, merge gate. | authoritative architecture | Keep. |
| `docs/architecture/shared-runtime.md` | Mostly target architecture; some seams still being introduced. | partially implemented authoritative architecture | Keep; validate during Epic 11. |
| `docs/architecture/capability-registry.md` | Intended minimal registry; implementation governed by roadmap. | planned authoritative architecture | Keep. |
| `docs/architecture/platform-boundary.md` | Matches current OSS/platform ownership decision. | authoritative | Keep. |
| `docs/architecture/01-current-architecture.md` | Detailed architecture review snapshot; may age quickly. | implemented-record | Keep as audit snapshot; do not treat above ADRs. |
| `docs/architecture/02-gap-analysis.md` | Some gaps remain active; some have been fixed after the review. | partially implemented | Keep but revalidate before using as backlog. |
| `docs/architecture/03-target-architecture.md` | Target architecture with new elements marked. | partially implemented | Keep as target reference, not a rewrite mandate. |
| `docs/roadmap/epic-11-runtime-hardening.md` | Explicitly declares itself the only approved Epic 11 plan. | active-roadmap | Keep as implementation source for Epic 11. |
| `docs/PRD.md` | Broadly matches implemented companion, worker, health, memory, Discord, fallback behavior; some details overlap newer architecture docs. | partially implemented / partially superseded | Keep as product reference; defer to ADRs/architecture on conflicts. |
| `docs/WORKER-GUIDE.md` | Matches current worker architecture and operator commands. | authoritative operations | Keep. |
| `docs/SAFE-RESTART.md` | Matches `AGENTS.md` restart policy. | authoritative operations | Keep. |
| `docs/soul.md` | `src/soul.ts`, `src/index.ts`, `src/index-health.ts`, and `src/cli.ts` implement SOUL loading/injection. Runtime default path is root `SOUL.md`. | runtime-design, implemented | Keep; update language from “proposed” to “implemented design” in a follow-up. |
| `docs/agent-driven-memory-research.md` | PRD and `AGENTS.md` describe implemented memory helper/sidecar/extractor behavior. | implemented-record | Keep; consider moving to `docs/research/implemented/` later. |
| `docs/bridge-event-normalization-research.md` | Current architecture references events store/reducer/adapter. Phases 1-5 are marked complete; Phase 6 deferred. | implemented-record plus deferred research | Keep; split completed implementation record from deferred renderer research later. |
| `docs/discord-compatibility-research.md` | README lists Discord services; doc marks baseline implemented and remaining hardening. | implemented-record plus follow-up checklist | Keep; consider promoting remaining hardening into roadmap if needed. |
| `docs/health-bolt-architecture.md` | `src/index-health.ts` uses `BridgeEngine` with health hooks and isolated DB/token. | implemented-record | Keep. |
| `docs/health-monitor-rectification.md` | Checklist mostly complete; only manual monitoring remains. | implemented-record/checklist | Keep or archive after monitoring complete. |
| `docs/native-telegram-layout-spike.md` | `src/messageDelivery.ts` and `src/nativeLayout.ts` still contain native layout routing and opportunistic rich-message table delivery. | partially implemented / partially superseded | Update status text; do not archive as fully retired. |
| `docs/prompt-optimization-loop-research.md` | `AGENTS.md` references it; `src/cli.ts` contains the optimized Telegram response style. Earlier `src/agentMemory.ts` note is stale. | implemented-record with stale notes | Keep; add status/front matter in follow-up. |
| `docs/antigravity-agent-view-spike.md` | `src/cli.ts` uses foreground Agy print/log path; no daemon/background implementation. | research-only / rejected default | Keep in research or move under `docs/research/`. |
| `docs/claude-agent-view-spike.md` | `src/cli.ts` uses foreground Claude print path; no default `--bg` path. | research-only / rejected default | Keep in research or move under `docs/research/`. |
| `docs/cursor-agent-spike-research.md` | Concludes cursor-agent is not viable. No current backend implementation. | rejected research | Keep in research/archive; do not implement. |
| `docs/cursor-sdk-spike-research.md` | Conditional future backend with API key/shim; not in roadmap. | deferred research | Keep in research; do not implement until promoted. |
| `docs/autonomous-agent-bridge-research.md` | Superseded pointer to worker guide, active roadmap, research, archive. | superseded-pointer | Keep until inbound references are removed; then archive. |
| `docs/oss-product-split-plan.md` | Superseded pointer to active roadmap, research, archive. | superseded-pointer | Keep until inbound references are removed; then archive. |
| `docs/research/future-runtime-evolution.md` | Explicit research-only promotion rules. | research-only | Keep. |
| `docs/archive/autonomous-agent-bridge-research-v1.md` | Explicitly historical only. | archived | Keep in archive. |
| `docs/archive/oss-product-split-plan-v1.md` | Explicitly historical only. | archived | Keep in archive. |

## Runtime dependency notes

### `docs/soul.md`

The design is implemented, but the runtime asset is not `docs/soul.md` by default.

Current behavior:

- `src/soul.ts` defaults to `<projectDir>/SOUL.md`.
- `AGENT_BRIDGE_SOUL_PATH` overrides the path.
- `AGENT_BRIDGE_SOUL_MODE` controls `summary`, `full`, or `off`.
- `src/index.ts` loads the context and passes it to each companion engine.
- `src/index-health.ts` also loads the same context for health suggestions.
- `src/cli.ts` renders the soul contract into the prompt wrapper for Codex, Claude, and Antigravity paths.

Recommendation: keep `docs/soul.md` as runtime design documentation and ensure a root `SOUL.md` exists when persona injection is desired.

### Worker docs

`docs/WORKER-GUIDE.md` is authoritative for operator behavior. Architecture docs define boundaries, but the worker guide owns commands, configuration, and troubleshooting.

### Research docs

Root research files should not be implementation sources unless promoted. Most can move under `docs/research/` in a future mechanical cleanup once inbound references are updated.

## Recommended next cleanup PRs

1. Add front matter to all significant docs using the taxonomy in `docs/README.md`.
2. Refresh `docs/native-telegram-layout-spike.md` status to reflect current rich-message/table behavior.
3. Refresh `docs/soul.md` language from proposed to implemented runtime design.
4. Move completed implementation records into a dedicated location such as `docs/implementation-records/` or `docs/research/implemented/` after references are updated.
5. Move rejected/deferred root research files under `docs/research/` after references are updated.
6. Archive superseded pointer files once `README.md`, `AGENTS.md`, and any external operator references stop linking to their root paths.

## Guardrail for future agents

Before modifying documentation structure, agents must:

1. Inventory `docs/` from a real checkout.
2. Search for each filename across code, tests, root docs, systemd files, and scripts.
3. Classify runtime dependencies separately from research/roadmap status.
4. Preserve root pointer files when inbound references exist.
5. Avoid moving runtime-design docs such as `docs/soul.md` without checking implementation code first.
