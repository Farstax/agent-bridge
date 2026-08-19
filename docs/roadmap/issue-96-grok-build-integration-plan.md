# Grok Build Integration Plan

**Related:** #416 (required spike), #96 (implementation, blocked on #416)  
**Status:** Plan only — no production provider code until #416 decision gate  
**Rollout impact:** none (docs-only)

## Review repairs (vs first draft)

This revision addresses four material plan defects:

1. **ACP does not fit the one-shot invocation seam.** Current `runSupervisedProcess()` writes stdin once, closes it, and returns buffered stdout on process exit. ACP is a long-lived bidirectional JSON-RPC process. If #416 selects ACP, implementation uses a **Grok-specific duplex executor/client**, not `buildInvocation()` / `parseResult()` alone.
2. **TDD sequence is per-phase.** Every behaviour-adding phase names a focused red test that fails because the desired capability is absent, then the minimum green implementation.
3. **Full provider vocabulary + dispatch fan-out** is planned: `PROVIDER_IDS`, registry, `BotKind` / config / `CliOptions`, `cli.ts` build/parse dispatch, selection chain maps, Doctor maps, and their tests.
4. **#96 acceptance for auth and install isolation** is planned with executable tests (deterministic unauthenticated failure + isolated executable/path collision policy), not prose alone.

---

## 1. Executive outcome

Add Grok Build as an optional native CLI provider in Agent Bridge by leaning into Grok’s own harness (ACP agent mode **or** headless `streaming-json`).

Agent Bridge continues to own only:

- durable Run identity & ownership
- cancellation / fencing
- continuation / restart recovery correlation
- delivery & idempotency
- hard mechanical safety invariants
- provider selection / fallback eligibility

Grok owns:

- session / thread state
- model + tool loop
- reasoning stream
- permissions
- native subagents / orchestration

**No** second agent state machine, no heuristic answer/reasoning parsing, no generic provider-daemon framework, no Worker resurrection.

### Contract-conditional execution seam (critical)

| #416 decision | Execution path |
|---------------|----------------|
| **B – headless `streaming-json`** | Fits the existing one-shot seam: `buildInvocation` → `runSupervisedProcess` → `parseResult` (and optional fail-closed stream decoder). |
| **A – ACP** | **Does not** fit `runSupervisedProcess` as currently designed. Requires a **provider-owned Grok ACP client/executor** that owns process lifetime, duplex stdin/stdout JSON-RPC, request correlation, cancellation/fencing, session new/load/resume, and final-result ownership. This is Grok-specific machinery under `src/providers/`, not a generic daemon framework. |
| **C – not ready** | Stop. No production provider. |

Headless is the natural first production path if evidence is equal; ACP is only chosen when #416 proves it is worth the extra executor surface.

---

## 2. Architecture alignment

| Principle | How this plan obeys it |
|-----------|------------------------|
| Native CLI first | Use only Grok’s documented ACP or `streaming-json` contracts |
| Provider adapter owns protocol | `grokRuntime.ts` for headless; `grokAcpClient.ts` (name TBD) for ACP |
| Shared runtime stays agnostic | `cliSupervisor` remains one-shot; ACP does not force a generic duplex supervisor |
| TDD red-green-refactor | Each phase below has explicit red → green |
| Fail-closed on unknown protocol | Mirror `claudeAnswerPresentation.ts` |
| Qualification is mechanical | version / fresh / resume only |

Current one-shot seam (must not be misused for ACP):

- `cli.ts` → `buildCliInvocation` / `parseCliResult` hard-code `codex` / `claude` / `antigravity`
- `runSupervisedProcess` → single stdin write, close, wait for exit, buffer stdout
- Claude streaming is **stdout decode during that one-shot run**, not a long-lived RPC session

Current hard-coded fan-out (must be extended, not only registry):

- `src/providers/types.ts` — `PROVIDER_IDS`
- `src/providers/registry.ts` — adapters + bot-name map
- `src/providers/selection.ts` — `PROVIDER_TO_CHAIN_KIND`, `ChainCliKind`
- `src/providers/doctor.ts` — `KNOWN_CHAIN_KINDS`, `CHAIN_KIND_TO_PROVIDER_ID`
- `src/cli.ts` — `buildCliInvocation` / `parseCliResult` / antigravity special path
- Config / types — `BotKind`, `BridgeConfig.bots`, `CliOptions.bot`, event context bot fields (inspect exact current definitions at implementation time)

---

## 3. Decision gate (owned by #416)

Before any production code:

1. Record exact `grok --version`.
2. Capture sanitized real traces for both surfaces (fresh, resume, tool use, reasoning separation, cancellation, long answer, error).
3. Prove user-visible answer events are discriminable without heuristics.
4. Measure first-safe-answer latency.
5. Document process-lifetime implications of ACP (long-lived duplex vs one-shot).
6. Explicit recommendation: **A – ACP** | **B – headless** | **C – not ready**.

### Official contract references (re-validate at spike time)

- Headless: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
- ACP agent mode: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md

Headless events (non-exhaustive): `text` (answer), `thought`, `tool_call` / `tool_call_update`, `end` (+ `sessionId`), `error`.

ACP updates of interest: `agent_message_chunk` (answer), `agent_thought_chunk`, `tool_call` / `tool_call_update`, `plan`.

---

## 4. Implementation plan (after #416)

### Phase 0 – Spike deliverable (docs + evidence only)

**Red:** none (docs).  
**Green deliverable:** `docs/research/grok-build-native-contract-spike.md` with version, sanitized traces, comparison table, latency, ACP lifetime notes, and A/B/C decision.  
**No production provider code.**

---

### Phase 1 – Provider vocabulary + registration (test-first)

**Desired behaviour:** Grok is a known provider id with registry metadata and config shape, without yet executing production Runs.

**Red (focused tests must fail for these reasons):**

- `PROVIDER_IDS` includes `"grok"` (fails: only `codex`/`claude`/`agy` exist).
- `getProviderAdapter("grok")` returns a stable adapter with `id: "grok"`, configurable executable path, capabilities initially conservative (`fallbackTarget: false` unless spike evidence says otherwise).
- `loadBotsConfig` / bot config accepts a `grok` entry (command path, model prefs as needed) without putting credentials in argv.
- Bot/provider name mapping resolves `"grok"` where applicable.

**Green:** minimum type + registry + config wiring so those tests pass. Still no live execution path required in this phase if dispatch is Phase 2.

Do **not** write a red test that asserts Grok is absent or that `getProviderAdapter("grok")` throws — that is current behaviour and is already green / non-diagnostic of the feature.

---

### Phase 2 – Dispatch fan-out across hard-coded seams (test-first)

**Desired behaviour:** Choosing bot/provider `grok` reaches Grok-owned build/parse (or ACP client) rather than falling through to `Unknown bot type` or a no-op default invocation.

**Red:**

- `buildCliInvocation({ bot: "grok", ... })` produces a Grok-shaped invocation (or delegates to ACP client entry) — fails today (falls through to empty default args path).
- `parseCliResult({ bot: "grok", stdout })` parses a fixture Grok envelope — fails today (`Unknown bot type`).
- Selection / Doctor chain maps accept or deliberately exclude Grok according to capability flags (exhaustive maps must not omit a registered interactive provider without an explicit test).
- Any `BotKind` / `CliOptions.bot` / event-context unions that hard-code three providers accept `grok` or document a deliberate narrower vocabulary with tests.

**Green:** extend `cli.ts` dispatch, `selection.ts` maps, `doctor.ts` maps, and type unions. Prefer table-driven dispatch over growing if/else chains when a small local refactor is clearly safer; do not invent a plugin framework.

---

### Phase 3 – Execution path (contract-conditional, test-first)

#### 3A — If #416 selects **headless `streaming-json`**

**Seam:** existing one-shot path.

**Red:**

- Fixture NDJSON with `text` + `end.sessionId` parses to `CliResult` with correct text and session id.
- `thought` / `tool_call` / unknown types never appear in user-visible text.
- Resume args include proven `--resume` / session id form from the spike.
- Cancellation: SIGINT/SIGTERM path respects existing fencing (process exit 130/143 style) without late delivery.

**Green:** `src/providers/grokRuntime.ts` with `buildInvocation` / `parseResult` (+ optional `hasUsableFinalResponse`). Wire through Phase 2 dispatch. Use shared prompt wrapping, effort, toolMode helpers like Claude/Codex.

#### 3B — If #416 selects **ACP**

**Seam:** **new Grok-owned duplex executor** (e.g. `src/providers/grokAcpClient.ts`). **Not** `runSupervisedProcess` as the protocol engine.

The client owns:

- process spawn (`grok agent --always-approve stdio` or spike-proven argv)
- JSON-RPC framing on stdin/stdout
- `initialize` → `session/new` or load/resume → `session/prompt`
- correlation of requests/responses/notifications
- streaming of only `agent_message_chunk` to the existing preview path when enabled
- terminal result assembly and native session id extraction
- cancellation: prefer protocol cancel if documented; else kill + Bridge fence; never allow late commit after fence
- restart: fail closed or proven `session/load` only — no Bridge-owned session reconstruction beyond what ACP exposes

**Red:**

- Fake duplex transport tests: initialize + session/new + prompt yields message chunks + terminal result.
- Unknown notification types fail closed for streaming.
- Cancel after partial chunks does not deliver a final user message.
- Missing auth fails boundedly (see Phase 5) without hanging on interactive login.

**Green:** Grok-specific client + thin integration from Run execution path that selects this client when provider is Grok/ACP. Document explicitly: this is **not** a generic provider-daemon framework; do not generalize to Codex/Claude here.

---

### Phase 4 – Safe answer streaming (only if contract proves it)

**Red:** decoder fixtures — only answer events emit deltas; thought/tool/plan/unknown disable or ignore streaming without leaking.

**Green:** `grokAnswerPresentation.ts` (headless `text` or ACP `agent_message_chunk`). Wire into the same Telegram preview / final-reconciliation path Claude uses. Final parsed result remains authoritative.

---

### Phase 5 – Auth bounded failure + install isolation (#96 acceptance)

These are **first-class phases**, not documentation afterthoughts.

#### 5A – Missing authentication fails boundedly

**Red:**

- Deterministic test: Grok invocation with auth deliberately absent (env scrubbed / fake binary returning auth error envelope) completes as a classified failure within timeout — **does not** wait indefinitely for interactive login, **does not** open a browser flow from the Bridge child.
- Error classification maps auth failure to `auth_required` (or existing equivalent) without broad false positives.

**Green:** child env and argv never rely on interactive login; timeout + classification path proven. Live qualification note: unauthenticated host may report `not_authenticated` rather than hanging.

#### 5B – Installation must not overwrite/shadow another binary

**Red:**

- Policy tests: configured executable is an **explicit path** or a **non-colliding name** (e.g. documented `grok-build` / path under a Bridge-managed prefix), not an ambient `grok` that could shadow unrelated tools.
- Doctor/config validation fails closed when the resolved binary path is missing or when a collision policy check fails (exact check defined against current install helpers at implementation time).

**Green:** config default and install docs use isolated path; `resolveProviderExecutable("grok")` never silently picks an arbitrary PATH collision. Operations docs describe update/drift/rollback without overwriting foreign tools.

---

### Phase 6 – Error classification, qualification, doctor, selection policy

**Red:**

- Classification fixtures for auth, capacity, model unavailable, transient, fatal from spike evidence.
- Qualification contract: `version`, `fresh_prompt`, `session_resume` (or `not_applicable`) for Grok.
- Doctor reports Grok availability from configured executable.
- Fallback eligibility remains **opt-in false** until explicit evidence/tests flip it.

**Green:** extend `errorClassification.ts`, `qualification.ts`, `PROVIDER-QUALIFICATION.md`, doctor, selection capabilities. Live qualification remains version-change / explicit only.

---

### Phase 7 – Integration gates

- Existing Codex/Claude/Agy fixtures remain green (no behavioural change).
- Architecture Lint, typecheck, exact-head CI, Release Artifact.
- Independent adversarial review of the exact head.
- No systemd unit for Grok until isolated live qualification passes on a managed host.

---

## 5. Explicit non-goals

- No generic provider-daemon / duplex framework for all providers
- No recreation of Grok’s tool/session/agent state machine inside Bridge
- No heuristic text parsing of answers or thoughts
- No automatic addition to fallback/advisor chains solely because Grok is registered
- No Worker / Engineering Worker path
- No production provider code before #416 decision
- No using `runSupervisedProcess` as if it were an ACP session server

---

## 6. Rollout impact

`Rollout impact: none` for this plan PR.  
Implementation PR: `none` if opt-in config only; `required` only if install scripts, default binaries, or systemd change.

---

## 7. Acceptance for this plan document

- [x] #416 remains the decision gate
- [x] Headless → existing one-shot seam; ACP → Grok-specific duplex executor (explicit)
- [x] Full vocabulary/dispatch fan-out listed with test ownership
- [x] Each behaviour phase has explicit red → green
- [x] Auth bounded failure + install collision isolation planned as executable acceptance
- [x] No production code in this PR

---

## 8. Suggested PR sequence

1. **This plan PR** (docs only).
2. **Spike PR** — advances #416 (traces + A/B/C).
3. **Implementation PR** — closes #96 following the chosen branch of Phase 3 and Phases 1–2, 4–7.

---

## Agent pickup note

Prefer the provider’s richest **stable** native contract that fits a safe Bridge seam. Headless `streaming-json` maps to today’s one-shot supervisor. ACP requires a Grok-owned duplex client and must not be forced into `buildInvocation`/`parseResult`/`runSupervisedProcess` alone. Do not implement production code until #416 records an explicit decision with sanitized traces. Auth must fail closed without interactive login waits; install must use an isolated executable path with collision tests.
