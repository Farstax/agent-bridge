# Grok Build Integration Plan

**Related:** [#416](https://github.com/nickconstantinou/agent-bridge/issues/416) (required capability spike), [#96](https://github.com/nickconstantinou/agent-bridge/issues/96) (implementation, blocked on #416)  
**Status:** Plan only — no production provider code until #416 decision gate  
**Rollout impact:** none (docs-only)

This document is a **sequenced plan for both issues**:

1. Execute **#416** exactly (inspect → probe → compare → decide A/B/C).  
2. Only then implement **#96** on the contract #416 selected, using the seams and TDD phases below.

#96 acceptance criterion zero is: *“#416 is complete with an explicit ACP/headless/not-ready decision and sanitized real traces.”* Nothing in Phases 1–7 of #96 may start before that.

---

## Review repairs (vs earlier drafts)

1. **ACP does not fit the one-shot invocation seam.** Current `runSupervisedProcess()` writes stdin once, closes it, and returns buffered stdout on exit. ACP is long-lived bidirectional JSON-RPC. If #416 selects ACP, implementation uses a **Grok-specific duplex executor/client**, not `buildInvocation()` / `parseResult()` alone.
2. **TDD is per-phase.** Every behaviour-adding phase names a focused red that fails because the desired capability is absent, then the minimum green.
3. **Full provider vocabulary + dispatch fan-out** is planned (`PROVIDER_IDS`, registry, config/`BotKind`/`CliOptions`, `cli.ts`, selection, Doctor).
4. **#96 auth + install isolation** have executable acceptance steps.
5. **#416 is fully factored in** — Phase 0 below is the operational checklist for the spike issue itself (probes, safety gate, comparison dimensions, measurement, decision gate, acceptance), not a one-line dependency note.

---

## 1. Executive outcome

Add Grok Build as an optional native CLI provider by leaning into Grok’s own harness (ACP **or** headless `streaming-json`), after #416 proves which surface is safe.

**Agent Bridge owns:** durable Run identity, cancellation/fencing, continuation/restart correlation, delivery, idempotency, hard mechanical safety, provider selection/fallback.  
**Grok owns:** session state, model/tool loop, reasoning, permissions, native subagents/orchestration, provider lifecycle under the selected contract.

**No** second agent state machine, no heuristic parsing, no generic provider-daemon framework, no Worker resurrection, no third invented parsing layer (#416 decision gate C).

### Contract-conditional execution seam (binding after #416)

| #416 decision | Execution path |
|---------------|----------------|
| **B – headless `streaming-json`** | Existing one-shot seam: `buildInvocation` → `runSupervisedProcess` → `parseResult` (+ optional fail-closed stream decoder). |
| **A – ACP** | **Grok-specific duplex ACP client** under `src/providers/`: process lifetime, JSON-RPC, request correlation, cancel/fence, session new/load/resume, final-result ownership. Not a generic daemon framework. |
| **C – not ready** | Stop. Defer #96. Do not invent adapters. |

#416’s preferred *test* direction is ACP-as-leading-candidate, but selection must be evidence-based: if headless provides the same safety/session/cancel semantics with materially less Bridge machinery, recommend the smaller integration.

---

## 2. Architecture alignment

Matches #416’s architecture rule and `AGENTS.md`:

> Prefer the provider’s richest stable native integration contract. Agent Bridge should stitch Grok Build into durable Run and delivery semantics, not recreate the Grok harness.

| Principle | Plan behaviour |
|-----------|----------------|
| Native CLI first | Only documented ACP or `streaming-json` |
| Provider owns protocol | `grokRuntime.ts` (headless) or `grokAcpClient.ts` (ACP) |
| Shared runtime agnostic | One-shot supervisor unchanged; ACP does not force a generic duplex supervisor |
| Fail-closed streaming | #416 safety gate: only `text` / `agent_message_chunk`; never thought/tool/plan/permission/raw/unknown |
| TDD | Per-phase red → green for #96; spike is evidence-only |

Current one-shot seam (must not be misused for ACP): `cli.ts` dispatch + `runSupervisedProcess` (single stdin write, close, buffer stdout). Claude streaming is stdout decode during that one-shot run, not long-lived RPC.

Hard-coded fan-out to extend for #96: `types.ts` `PROVIDER_IDS`, `registry.ts`, `selection.ts` maps, `doctor.ts` maps, `cli.ts` build/parse, config/`BotKind`/`CliOptions`/event context.

---

## 3. Phase 0 — Execute #416 (capability spike only)

**This phase is the body of issue #416.** No production Agent Bridge provider is added or changed. Finish with a clear A/B/C recommendation and, if justified, confirm #96 remains the narrow integration issue (or open a replacement if scope must change).

Deliverable file: `docs/research/grok-build-native-contract-spike.md` (or equivalent under `docs/roadmap/`), plus sanitized trace artifacts as needed.

### 3.0 Official references (re-validate at spike time)

- Headless: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md  
- ACP: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md  

Use official docs **and** repository source. Do not infer contracts from TUI rendering.

### 3.1 Phase 0 inspection — exact supported contracts

Record:

1. Exact `grok --version`.
2. Headless `--help` for `--output-format streaming-json`, session IDs, resume/continue, cancellation, permissions.
3. ACP startup/initialize capabilities.
4. Supported session create/load/resume operations.
5. All standard and xAI extension notifications relevant to Agent Bridge.
6. Whether protocol/version/capability discovery is sufficient to **fail closed across drift**.

### 3.2 Required real probes — headless `streaming-json`

Capture **sanitized** traces for at least:

1. Fresh short answer  
2. Resumed session using the returned session ID  
3. Tool use followed by answer  
4. Reasoning + answer separation  
5. Cancellation via SIGINT/SIGTERM or documented mechanism  
6. Failure/error path  
7. Long answer  

**Prove:** `text` events are user-visible answer content; `thought`, tool/lifecycle, unknown, and error events **cannot** leak into Telegram.

Documented headless event types (non-exhaustive; treat as open set and fail closed on unknown):

| Type | Role |
|------|------|
| `text` | Candidate user-visible answer chunk |
| `thought` | Reasoning — never surface |
| `tool_call` / `tool_call_update` | Tool lifecycle — never surface |
| `end` | Terminal metadata including `sessionId` |
| `error` | Failure |

### 3.3 Required real probes — ACP

Capture **sanitized** JSON-RPC traces for at least:

1. `initialize` + `session/new`  
2. Short answer via `session/prompt`  
3. `agent_message_chunk` ordering and terminal response  
4. Reasoning via `agent_thought_chunk` kept separate  
5. Tool call + tool call update followed by answer  
6. Session load/resume after process restart/reconnect  
7. Cancellation  
8. Long answer  
9. Failure path  
10. Native subagent behaviour if exposed by the supported release — **without** adding Agent Bridge-owned subagent state  

### 3.4 Safety gate for answer streaming (#416 — binding on #96)

Stream **only** event types explicitly documented as user-visible answer text:

- headless: candidate `text`  
- ACP: candidate `agent_message_chunk`  

Everything else must fail closed. **Never** surface: thought / `agent_thought_chunk`, tool inputs/results, plan/protocol events, permission requests, raw NDJSON/JSON-RPC, stderr/logging, credentials, unknown event types. **No heuristic terminal parsing.**

### 3.5 Narrow comparison dimensions (#416)

Compare ACP vs headless **only** on:

- first safe answer availability  
- session identity/resume semantics  
- restart/reconnect behaviour  
- cancellation  
- tool/reasoning separation  
- final authoritative result  
- process ownership complexity  
- compatibility with Agent Bridge Run/fencing/delivery semantics  
- ability to preserve Grok-native subagents/orchestration later  

Do **not** turn the spike into a broad product evaluation.

### 3.6 Process-lifecycle question (if ACP is a contender)

Determine the smallest safe ownership model. Prefer a **bounded provider-native process per Agent Bridge provider runtime/workspace**, with Grok owning sessions underneath. Explicitly test restart/reconnect and `session/load` before any Bridge-owned daemon/session reconstruction. **Do not** create a generic provider-daemon framework in the spike or in #96.

This is the evidence that decides whether Phase 3B (duplex client) is justified vs “not ready” or headless.

### 3.7 Measurement

For representative short turns capture:

```text
prompt accepted
first provider event
first eligible answer chunk
terminal provider result
```

Compare ACP and headless potential time-to-first-visible answer. Presentation-latency evidence only — not a model benchmark.

### 3.8 Decision gate (exactly as #416)

End with **one** recommendation:

- **A — ACP** — only if evidence proves it is the richest stable contract without unnecessary Bridge machinery.  
- **B — headless `streaming-json`** — only if it preserves required session/cancellation/safety semantics and is materially simpler.  
- **C — not ready** — if neither is sufficiently safe/stable; document the exact limitation and defer #96. **Do not invent a third parsing layer.**

### 3.9 #416 acceptance criteria (checklist for spike close)

- [ ] Exact Grok Build version recorded  
- [ ] Official ACP and headless docs/source reviewed and linked  
- [ ] Sanitized real traces for both surfaces  
- [ ] User-visible answer event discrimination proven  
- [ ] Reasoning/tool/protocol separation proven  
- [ ] Fresh/resumed/reloaded session behaviour documented  
- [ ] Cancellation and terminal semantics documented  
- [ ] Restart/reconnect behaviour documented for ACP  
- [ ] Potential first-visible latency measured  
- [ ] ACP vs headless recommendation explicit and evidence-based  
- [ ] Follow-up integration remains #96 only if justified (or issue updated)  
- [ ] **No** production Agent Bridge provider added or changed by the spike  

Related spikes for pattern reference: #413 (Codex App Server), #414 (Agy stream-json), #415 (Kimchi).

---

## 4. Phases 1–7 — Execute #96 only after #416 decision ≠ C

**Hard gate:** If #416 → **C**, stop. Keep #96 deferred.

Implementation must follow the **selected** native contract and #416 traces, not older assumptions in #96’s text. Capabilities registered must be **only those proven** by #416.

### Phase 1 – Provider vocabulary + registration (test-first)

**Desired:** Grok is a known provider id with registry metadata and config shape.

**Red** (must fail because capability is missing — not because “Grok is absent”):

- `PROVIDER_IDS` includes `"grok"`  
- `getProviderAdapter("grok")` returns stable adapter; executable is **exact configurable path**, not a generic `agent` alias (#96)  
- Config accepts `grok` entry; credentials never in argv  
- Capabilities initially conservative; `interactive` / `fallbackTarget` / tool-free only if #416 evidence supports them  

**Green:** minimum types + registry + config.

### Phase 2 – Dispatch fan-out (test-first)

**Desired:** bot/provider `grok` reaches Grok-owned path, not `Unknown bot type` or empty default invocation.

**Red:** `buildCliInvocation` / `parseCliResult` (or ACP client entry) for `grok`; selection/Doctor exhaustive maps; `BotKind` / `CliOptions` / event-context unions as needed.

**Green:** extend `cli.ts`, `selection.ts`, `doctor.ts`, type unions. Prefer small table-driven dispatch; no plugin framework.

### Phase 3 – Execution path (contract-conditional)

#### 3A — #416 selected **headless**

**Red:** NDJSON fixtures — `text` + `end.sessionId`; thought/tool/unknown never in user text; resume argv per spike; cancel/fence behaviour.

**Green:** `grokRuntime.ts` `buildInvocation` / `parseResult` on existing one-shot seam. Shared prompt wrapping, effort, toolMode as Claude/Codex.

#### 3B — #416 selected **ACP**

**Red:** Fake duplex transport — initialize, session/new or load, prompt, message chunks, terminal result; unknown notifications fail closed; cancel after partial chunks does not final-deliver; auth absence bounded (Phase 5).

**Green:** Grok-owned duplex client (process, JSON-RPC, correlation, cancel/fence, session load). Prefer bounded process per runtime/workspace per #416 process-lifecycle guidance. **Not** `runSupervisedProcess` as protocol engine. **Not** a generic daemon framework.

Native session/resume/reload: **proven in #416 or explicitly disabled** in #96 (#96 acceptance).

### Phase 4 – Safe answer streaming (only if #416 proved discriminators)

Implements #416 safety gate in production code.

**Red:** only answer events emit deltas; thought/tool/plan/permission/unknown disable or ignore without leak.

**Green:** `grokAnswerPresentation.ts` (`text` or `agent_message_chunk`). Reuse Claude’s Telegram preview / final-reconciliation path. Final parsed result remains authoritative.

### Phase 5 – Auth bounded failure + install isolation (#96 acceptance)

#### 5A – Missing authentication

**Red:** scrubbed/unauthenticated invocation fails within timeout as classified auth failure; **no** indefinite interactive login wait; **no** browser login from Bridge child.

**Green:** child env/argv non-interactive; classification `auth_required` (or equivalent) without broad false positives. Live qual may report `not_authenticated`.

#### 5B – Install must not overwrite/shadow another binary

**Red:** explicit path or non-colliding name policy tests; Doctor/config fail closed on missing/collision.

**Green:** isolated install path; `resolveProviderExecutable("grok")` never silently picks arbitrary PATH collisions. Ops docs: update/drift/rollback/removal without foreign tool overwrite.

### Phase 6 – Error classification, qualification, doctor, selection policy

**Red:** classification fixtures (auth, capacity, model unavailable, timeout, transient, fatal) from #416 evidence; qualification `version` / `fresh_prompt` / `session_resume` (or `not_applicable`); Doctor availability; fallback remains opt-in false until explicit evidence.

**Green:** extend classification, qualification, docs, doctor, selection. Live qualification version-change / explicit only. Secrets absent from args, logs, diagnostics, telemetry (#96).

### Phase 7 – Integration gates

- Existing Codex/Claude/Agy contracts unchanged  
- Full tests, typecheck, Architecture Lint, Release Artifact  
- Relevant isolated live qualification  
- Independent adversarial review of exact head  
- No managed-host enablement / systemd until isolated live qual passes (#96 ops)  

---

## 5. Explicit non-goals

From #416 and #96 combined:

- No production provider in the spike  
- No third parsing layer if contracts are inadequate  
- No generic provider-daemon framework  
- No recreation of Grok’s tool/session/agent state machine  
- No heuristic answer/reasoning parsing  
- No auto-add to fallback/advisor chains solely because registered  
- No Worker integration  
- No using `runSupervisedProcess` as an ACP session server  

---

## 6. Rollout impact

- This plan PR: **none**  
- #416 spike PR: **none** (docs + evidence)  
- #96 implementation: **none** if opt-in config only; **required** only if install scripts, default binaries, or systemd change  

---

## 7. Acceptance for this plan document

- [x] #416 is fully specified as Phase 0 (inspect, probes, safety gate, compare, lifecycle, measure, A/B/C, acceptance checklist)  
- [x] #96 is explicitly blocked on #416 ≠ C and on following the selected contract  
- [x] Headless → one-shot seam; ACP → Grok duplex client  
- [x] Fan-out, per-phase TDD, auth, install collision planned  
- [x] No production code in this PR  

---

## 8. Suggested PR sequence

1. **This plan PR** (docs).  
2. **Spike PR** — closes or advances **#416** (traces + A/B/C only).  
3. **Implementation PR** — closes **#96** on the chosen branch of Phase 3 + Phases 1–2, 4–7.  

---

## Agent pickup note

**Do #416 first, completely.** Prefer the provider’s richest *stable* native contract that fits a safe Bridge seam. Headless maps to today’s one-shot supervisor; ACP needs a Grok-owned duplex client and #416’s process-lifecycle evidence. Stream only `text` / `agent_message_chunk`. Fail closed on everything else. Auth fails boundedly without interactive login. Install uses an isolated executable path. If #416 says not ready, do not implement #96.
