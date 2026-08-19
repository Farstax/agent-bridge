# Grok Build Integration Plan

**Related:** [#416](https://github.com/nickconstantinou/agent-bridge/issues/416) (required capability spike), [#96](https://github.com/nickconstantinou/agent-bridge/issues/96) (implementation, blocked on #416)  
**Status:** Plan + **partial #416 evidence** — paused pending authentication; no production provider code; **A/B/C decision withheld**  
**Rollout impact:** none (docs-only)  
**Spike evidence file:** [`docs/research/grok-build-native-contract-spike.md`](../research/grok-build-native-contract-spike.md)

This document is a **sequenced plan for both issues**:

1. Execute **#416** exactly (inspect → probe → compare → decide A/B/C).  
2. Only then implement **#96** on the contract #416 selected, using the seams and TDD phases below.

#96 acceptance criterion zero is: *“#416 is complete with an explicit ACP/headless/not-ready decision and sanitized real traces.”* Nothing in Phases 1–7 of #96 may start before that.

---

## Spike progress snapshot (2026-08-19) — pick up here

Work started on #416 against a real install, then **paused** for non-interactive auth. Full success-path matrices and the A/B/C decision are **not** done.

### Environment

| Item | Value |
|------|--------|
| Grok Build version | **`grok 1.0.5 (5115b46bc9)`** (linux-x86_64) |
| Install | Official `https://x.ai/cli/install.sh` → `/root/.grok/bin/grok` (symlinked as `grok` / `agent`) |
| Auth on spike host | **None** — no `XAI_API_KEY`, no device login, no `~/.grok/auth.json` credentials usable for prompts |
| Local docs | Shipped under `~/.grok/docs/user-guide/` including `14-headless-mode.md`, `15-agent-mode.md` |

### Completed

| #416 item | Result |
|-----------|--------|
| Exact version | Recorded |
| Headless `--help` contract | `-p/--single`, `--output-format` (`plain` / `json` / `streaming-json` / `streaming-messages-json`), `--resume` / `--continue` / `--session-id` / `--fork-session`, `--always-approve`, `--permission-mode`, `--cwd`, `--max-turns`, `--no-subagents` |
| ACP CLI surface | `grok agent stdio` (also `serve`, `headless` WS relay, `leader`) |
| Official docs reviewed | Installed user-guide + upstream headless/agent-mode pages |
| Headless **unauthenticated** probe | Stdout single line `{"type":"error","message":"Not signed in…"}`; **exit 1**; completes in seconds — **no interactive login hang** |
| ACP **`initialize`** (no auth) | **Succeeds** — `protocolVersion: 1`, `loadSession: true`, session list/resume/close caps, auth methods advertised (`grok.com`), model catalog metadata (`grok-4.6` / `grok-4.5`), xAI capability extensions |
| ACP **`session/new`** (no auth) | **Fail closed** — JSON-RPC `{"code":-32000,"message":"Authentication required","data":"no auth method id provided"}`; no `sessionId`; no prompt attempted |
| Production Agent Bridge code | **Unchanged** (spike only) |

### Not completed (blocked on auth)

- Headless success path: fresh short answer, resume via session ID from `end`, tool use, reasoning/answer separation, SIGINT/SIGTERM cancel mid-stream, long answer, first-`text` latency  
- ACP success path: authenticated `session/new`, `session/prompt`, `agent_message_chunk` ordering, `agent_thought_chunk` separation, tools, load/resume after process restart, cancel, long answer, failure after auth, native subagents, latency  
- Narrow ACP vs headless comparison table  
- Process-lifecycle recommendation for ACP  
- **Decision gate A / B / C**

### Preliminary observations (not a decision)

1. **Headless** already looks aligned with the existing one-shot `runSupervisedProcess` seam (`-p` + structured stdout + process exit).  
2. **ACP** is confirmed long-lived duplex; `initialize` ≠ ready-to-Run — auth is enforced at `session/new`. Plan Phase 3B (Grok-specific duplex client) remains required if ACP is chosen.  
3. **Missing auth** fails boundedly on both surfaces in this environment — useful evidence for #96 Phase 5A.  
4. **Streaming safety** (only `text` / `agent_message_chunk`) remains **unproven** until authenticated traces exist.

### Resume checklist (next session)

1. Provide non-interactive auth on the spike host: `XAI_API_KEY` **or** `grok login --device-code` (or equivalent).  
2. Re-install or confirm `grok --version` still matches (re-record if drifted).  
3. Run remaining probes in §3.2 and §3.3 below; sanitize traces into `docs/research/grok-build-native-contract-spike.md`.  
4. Fill comparison + lifecycle + latency; emit **A / B / C**.  
5. Only then start #96 Phases 1–7.

---

## Review repairs (vs earlier drafts)

1. **ACP does not fit the one-shot invocation seam.** Current `runSupervisedProcess()` writes stdin once, closes it, and returns buffered stdout on exit. ACP is long-lived bidirectional JSON-RPC. If #416 selects ACP, implementation uses a **Grok-specific duplex executor/client**, not `buildInvocation()` / `parseResult()` alone. **Partial live confirmation:** ACP `initialize` keeps a stdio process up; session creation is a separate RPC.
2. **TDD is per-phase.** Every behaviour-adding phase names a focused red that fails because the desired capability is absent, then the minimum green.
3. **Full provider vocabulary + dispatch fan-out** is planned (`PROVIDER_IDS`, registry, config/`BotKind`/`CliOptions`, `cli.ts`, selection, Doctor).
4. **#96 auth + install isolation** have executable acceptance steps. **Partial live confirmation:** headless and ACP already fail closed without interactive hang when unsigned-in.
5. **#416 is fully factored in** — Phase 0 below is the operational checklist for the spike issue itself.

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

Deliverable file: `docs/research/grok-build-native-contract-spike.md`, plus sanitized trace artifacts as needed.

**Current state:** inspection + unauthenticated probes recorded (see **Spike progress snapshot** above and the research file). Authenticated matrices and decision **outstanding**.

### 3.0 Official references (re-validate at spike time)

- Headless: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md  
- ACP: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md  
- Also installed locally with the CLI under `~/.grok/docs/user-guide/`

Use official docs **and** repository source. Do not infer contracts from TUI rendering.

### 3.1 Phase 0 inspection — exact supported contracts

| # | Item | Status (2026-08-19) |
|---|------|---------------------|
| 1 | Exact `grok --version` | **Done** — `1.0.5 (5115b46bc9)` |
| 2 | Headless help: streaming-json, session, resume, cancel, permissions | **Done** — see snapshot |
| 3 | ACP startup/initialize capabilities | **Done** — live `initialize` without auth |
| 4 | Session create/load/resume operations | **Partial** — capabilities advertised; authenticated create/load/resume **not** exercised |
| 5 | Standard + xAI extension notifications | **Partial** — capability `_meta` seen; full event vocabulary needs success-path traces |
| 6 | Fail closed across drift via capability discovery | **Partial** — initialize surface is rich; not proven across version drift |

### 3.2 Required real probes — headless `streaming-json`

| # | Probe | Status |
|---|-------|--------|
| 1 | Fresh short answer | **Blocked** (auth) |
| 2 | Resumed session via returned session ID | **Blocked** (auth) |
| 3 | Tool use followed by answer | **Blocked** (auth) |
| 4 | Reasoning + answer separation | **Blocked** (auth) |
| 5 | Cancellation (SIGINT/SIGTERM or documented) | **Blocked** (auth) |
| 6 | Failure/error path | **Done (unauthenticated)** — structured `type:error`, exit 1 |
| 7 | Long answer | **Blocked** (auth) |

**Prove when unblocked:** `text` is user-visible answer content; `thought`, tool/lifecycle, unknown, and error events cannot leak into Telegram.

Documented headless event types (non-exhaustive; fail closed on unknown):

| Type | Role |
|------|------|
| `text` | Candidate user-visible answer chunk |
| `thought` | Reasoning — never surface |
| `tool_call` / `tool_call_update` | Tool lifecycle — never surface |
| `end` | Terminal metadata including `sessionId` |
| `error` | Failure (observed unauthenticated) |

### 3.3 Required real probes — ACP

| # | Probe | Status |
|---|-------|--------|
| 1 | `initialize` + `session/new` | **Partial** — `initialize` OK; `session/new` auth-required error without credentials |
| 2 | Short answer via `session/prompt` | **Blocked** (auth) |
| 3 | `agent_message_chunk` ordering + terminal | **Blocked** (auth) |
| 4 | `agent_thought_chunk` kept separate | **Blocked** (auth) |
| 5 | Tool call + update + answer | **Blocked** (auth) |
| 6 | Session load/resume after process restart | **Blocked** (auth) |
| 7 | Cancellation | **Blocked** (auth) |
| 8 | Long answer | **Blocked** (auth) |
| 9 | Failure path | **Partial** — unauthenticated `session/new` error only |
| 10 | Native subagent if exposed | **Blocked** (auth) |

### 3.4 Safety gate for answer streaming (#416 — binding on #96)

Stream **only** event types explicitly documented as user-visible answer text:

- headless: candidate `text`  
- ACP: candidate `agent_message_chunk`  

Everything else must fail closed. **Never** surface: thought / `agent_thought_chunk`, tool inputs/results, plan/protocol events, permission requests, raw NDJSON/JSON-RPC, stderr/logging, credentials, unknown event types. **No heuristic terminal parsing.**

**Status:** Gate definition stands; **not yet proven** on success-path traces.

### 3.5 Narrow comparison dimensions (#416)

Compare ACP vs headless **only** on: first safe answer availability; session identity/resume; restart/reconnect; cancellation; tool/reasoning separation; final authoritative result; process ownership complexity; compatibility with Run/fencing/delivery; later native subagents/orchestration.

**Status:** Comparison table **not started** (needs both success paths).

### 3.6 Process-lifecycle question (if ACP is a contender)

Prefer a **bounded provider-native process per Agent Bridge provider runtime/workspace**, with Grok owning sessions underneath. Explicitly test restart/reconnect and `session/load` before any Bridge-owned daemon/session reconstruction. **Do not** create a generic provider-daemon framework.

**Status:** Unauthenticated ACP confirms long-lived stdio process; authenticated lifecycle **not** tested.

### 3.7 Measurement

Capture for short turns: `prompt accepted` → `first provider event` → `first eligible answer chunk` → `terminal provider result`.

**Status:** **Not measured** (no successful prompts).

### 3.8 Decision gate (exactly as #416)

End with **one** recommendation: **A — ACP** | **B — headless** | **C — not ready**.

**Status:** **Withheld** — resume after authenticated probes.

### 3.9 #416 acceptance criteria (checklist for spike close)

- [x] Exact Grok Build version recorded  
- [x] Official ACP and headless docs/source reviewed and linked  
- [ ] Sanitized real traces for **both** surfaces (success paths outstanding)  
- [ ] User-visible answer event discrimination proven  
- [ ] Reasoning/tool/protocol separation proven  
- [ ] Fresh/resumed/reloaded session behaviour documented  
- [ ] Cancellation and terminal semantics documented  
- [ ] Restart/reconnect behaviour documented for ACP  
- [ ] Potential first-visible latency measured  
- [ ] ACP vs headless recommendation explicit and evidence-based  
- [ ] Follow-up integration remains #96 only if justified  
- [x] **No** production Agent Bridge provider added or changed by the spike  
- [x] Unauthenticated fail-closed behaviour documented for headless + ACP  

Related spikes: #413 (Codex App Server), #414 (Agy stream-json), #415 (Kimchi).

---

## 4. Phases 1–7 — Execute #96 only after #416 decision ≠ C

**Hard gate:** If #416 → **C**, stop. Keep #96 deferred. **Do not start these phases while the decision is withheld.**

Implementation must follow the **selected** native contract and #416 traces. Capabilities registered must be **only those proven** by #416.

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

**Spike note:** Unauthenticated headless (`type:error`, exit 1) and ACP (`-32000 Authentication required` on `session/new`) already demonstrate bounded failure shapes usable as fixtures.

#### 5B – Install must not overwrite/shadow another binary

**Red:** explicit path or non-colliding name policy tests; Doctor/config fail closed on missing/collision.

**Green:** isolated install path; `resolveProviderExecutable("grok")` never silently picks arbitrary PATH collisions. Ops docs: update/drift/rollback/removal without foreign tool overwrite.

**Spike note:** Official installer also links `agent` → same binary; collision policy must account for both `grok` and `agent` names on PATH.

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
- #416 spike completion: **none** (docs + evidence)  
- #96 implementation: **none** if opt-in config only; **required** only if install scripts, default binaries, or systemd change  

---

## 7. Acceptance for this plan document

- [x] #416 is fully specified as Phase 0 (inspect, probes, safety gate, compare, lifecycle, measure, A/B/C, acceptance checklist)  
- [x] Partial #416 results recorded with explicit resume checklist  
- [x] #96 is explicitly blocked on #416 ≠ C and on following the selected contract  
- [x] Headless → one-shot seam; ACP → Grok duplex client  
- [x] Fan-out, per-phase TDD, auth, install collision planned  
- [x] No production code in this PR  

---

## 8. Suggested PR sequence

1. **This plan PR** (docs + partial spike evidence).  
2. **Spike completion** — finish **#416** after auth (remaining traces + A/B/C); update research doc.  
3. **Implementation PR** — closes **#96** on the chosen branch of Phase 3 + Phases 1–2, 4–7.  

---

## Agent pickup note

**Paused mid-#416.** Next agent: authenticate the spike host, continue from **Spike progress snapshot → Resume checklist**, complete §3.2–3.8, then decide A/B/C. Do not implement #96 while the decision is withheld. Prefer the provider’s richest *stable* native contract that fits a safe Bridge seam. Headless maps to today’s one-shot supervisor; ACP needs a Grok-owned duplex client. Stream only `text` / `agent_message_chunk`. Fail closed on everything else. Auth fails boundedly without interactive login (already observed). Install uses an isolated executable path (watch for installer `agent` symlink collisions).
