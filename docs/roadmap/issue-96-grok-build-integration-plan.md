# Grok Build Integration Plan

**Related:** #416 (required spike), #96 (implementation, blocked on #416)  
**Status:** Plan only — no production provider code until #416 decision gate  
**Rollout impact:** none (docs-only)

## 1. Executive outcome

Add Grok Build as an optional native CLI provider in Agent Bridge by leaning into Grok’s own harness (ACP agent mode **or** headless `streaming-json`), exactly as the existing Codex / Claude / Agy adapters do.

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

## 2. Architecture alignment (from `AGENTS.md` + current code)

| Principle | How this plan obeys it |
|-----------|------------------------|
| Native CLI first | Use only Grok’s documented ACP or `streaming-json` contracts |
| Provider adapter owns protocol | New `src/providers/grokRuntime.ts` (+ optional answer-presentation decoder) |
| Shared runtime stays agnostic | `cliSupervisor`, registry dispatch, qualification, error classification remain provider-agnostic |
| TDD red-green-refactor | Every behaviour change starts with a focused failing test commit |
| Fail-closed on unknown protocol | Mirror `claudeAnswerPresentation.ts` exactly |
| Qualification is mechanical | Extend `src/providers/qualification.ts` with version / fresh / resume checks only |

Current provider shape (from `registry.ts` + `types.ts` + `claudeRuntime.ts` / `codexRuntime.ts`):

```ts
// types.ts today
export const PROVIDER_IDS = ["codex", "claude", "agy"] as const;

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  executable: string;
  versionArgs: readonly string[];
  defaultArgs: readonly string[];
  capabilities: { interactive: boolean; fallbackTarget: boolean; toolFree: boolean };
  processWatch?: ...
}
```

Claude already demonstrates the streaming pattern we will copy:

- `buildInvocation` / `parseResult` in `claudeRuntime.ts`
- Fail-closed answer-delta decoder in `claudeAnswerPresentation.ts` (only `text_delta` is surfaced)

## 3. Decision gate (owned by #416)

Before any production code:

1. Record exact `grok --version`.
2. Capture sanitized real traces for both surfaces (fresh, resume, tool use, reasoning separation, cancellation, long answer, error).
3. Prove user-visible answer events are discriminable without heuristics.
4. Measure first-safe-answer latency.
5. Explicit recommendation:
   - **A – ACP** (preferred if session load/resume + typed chunks are solid)
   - **B – headless `streaming-json`** (preferred if materially simpler and still safe)
   - **C – not ready**

Only after that decision does #96 proceed.

### Official contract references (re-validate at spike time)

- Headless: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
- ACP agent mode: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md

Headless `streaming-json` events (non-exhaustive):

| Type | Role |
|------|------|
| `text` | User-visible answer chunk |
| `thought` | Internal reasoning — never surface |
| `tool_call` / `tool_call_update` | Tool lifecycle — never surface |
| `end` | Terminal metadata including `sessionId` |
| `error` | Failure |

ACP session updates of interest:

| sessionUpdate | Role |
|---------------|------|
| `agent_message_chunk` | User-visible answer chunk |
| `agent_thought_chunk` | Reasoning — never surface |
| `tool_call` / `tool_call_update` | Tool lifecycle |
| `plan` | Plan events |

## 4. Implementation plan (after #416 chooses a contract)

### Phase 0 – Spike deliverable (docs + evidence only)

- New file: `docs/research/grok-build-native-contract-spike.md` (or under `docs/roadmap/`)
- Contains version, traces (sanitized), comparison table, latency numbers, and the A/B/C decision.
- No production provider code.
- PR title example: `docs: Grok Build ACP vs streaming-json spike (#416)`

### Phase 1 – Registry + types (test-first)

1. **Red test**
   - Extend `test/providerInvocationFixtures.test.ts` (or new `test/grokRuntime.test.ts`) asserting:
     - `PROVIDER_IDS` does **not** yet contain `"grok"`
     - `getProviderAdapter("grok")` throws
2. **Green implementation**
   - Add `"grok"` to `PROVIDER_IDS`
   - Add adapter entry in `registry.ts`:

     ```ts
     grok: {
       id: "grok",
       displayName: "Grok Build",
       executable: "grok",          // exact path configurable via bots config
       versionArgs: ["--version"],
       defaultArgs: [],             // filled by runtime from chosen contract
       capabilities: {
         interactive: true,         // only if proven
         fallbackTarget: false,     // start conservative; enable only after evidence
         toolFree: true,            // if Grok supports equivalent
       },
     }
     ```

   - Map bot name `"grok"` in `BOT_NAME_TO_PROVIDER_ID`
   - Config: `loadBotsConfig` gains a `grok` entry (command path, model, etc.) — never put credentials in argv

### Phase 2 – Runtime module (mirrors Claude / Codex)

Create `src/providers/grokRuntime.ts`:

```ts
export function buildInvocation(req: ProviderInvocationRequest): ProviderInvocation
export function parseResult(stdout: string): CliResult
// + optional hasUsableFinalResponse if needed for cancellation races
```

**If ACP wins**

- Spawn `grok agent --always-approve stdio` (or equivalent proven flags)
- Speak JSON-RPC: `initialize` → `session/new` → `session/prompt`
- Consume `session/update` notifications
- Extract only `agent_message_chunk` for answer text
- Persist / resume via native `sessionId` / load semantics proven in the spike
- Map SIGTERM / documented cancel to ACP cancel if available; otherwise process kill + fence

**If headless wins**

- `grok -p <prompt> --output-format streaming-json` (+ `--resume <id>` when present)
- Parse NDJSON, surface only `type === "text"` events
- Take `sessionId` from the terminal `end` event
- Cancellation = SIGINT/SIGTERM (already documented exit codes 130/143)

In both cases:

- `nativeSessionMode: "fresh" | "resume"` exactly as other runtimes
- Prompt wrapping, soul context, effort, toolMode, outputDir follow the shared helpers already used by Claude/Codex
- Secrets never appear in argv, logs, or diagnostics

### Phase 3 – Safe answer streaming (only if contract proves it)

Mirror `claudeAnswerPresentation.ts` → `grokAnswerPresentation.ts`:

```ts
// Fail-closed decoder
// - headless: only "text" events
// - ACP: only agent_message_chunk
// - everything else (thought, tool_call, plan, unknown) → disable streaming
```

Wire into the existing Telegram preview / final-reconciliation path that Claude already uses. Final parsed `CliResult` remains authoritative.

### Phase 4 – Error classification

Extend `src/providers/errorClassification.ts` with Grok-specific patterns (auth, capacity, model unavailable, transient, fatal) using only evidence from the spike. Keep the existing closed set of classification kinds.

### Phase 5 – Qualification

Extend `src/providers/qualification.ts` and `docs/PROVIDER-QUALIFICATION.md`:

1. `version` – `grok --version`
2. `fresh_prompt` – bounded non-interactive prompt, mechanical success + session ID if exposed
3. `session_resume` – resume that ID (or `not_applicable` if the chosen contract cannot)

Live qualification stays opt-in / version-change triggered, never on every CI run.

### Phase 6 – Config, doctor, selection, docs

- `src/providers/doctor.ts` – report Grok presence / version
- Selection / fallback eligibility – start **opt-in only**; do not auto-add to fallback chains
- `docs/INITIAL-INSTALL.md` / operations docs – isolated install path, binary name collision avoidance, auth (`XAI_API_KEY` or device flow), update/drift policy
- No systemd unit for Grok until live qualification passes on a managed host

### Phase 7 – Tests & gates (mandatory)

- Focused red → green commits (tests first, never bundled with implementation)
- Existing provider fixtures remain green (no behavioural change to Codex/Claude/Agy)
- Architecture Lint, typecheck, exact-head CI, Release Artifact
- Independent adversarial review of the exact head

## 5. Explicit non-goals

- No generic provider-daemon framework
- No recreation of Grok’s tool/session/agent state machine
- No heuristic text parsing of answers or thoughts
- No automatic addition to fallback/advisor chains solely because the provider is registered
- No Worker / Engineering Worker path (removed on current `main`)
- No production provider code before #416 decision

## 6. Rollout impact

`Rollout impact: none` for this plan/spike PR.  
Later implementation PR that actually registers the provider will be `Rollout impact: required` only if it changes install scripts, systemd, or default config; otherwise still none (opt-in registration).

## 7. Acceptance for this plan document

- Plan document lands under `docs/roadmap/`
- Links #416 and #96
- Matches current provider ownership boundaries and TDD rules from `AGENTS.md`
- No production code
- Exact-head CI / Architecture Lint / Release Artifact remain green (docs-only)

## 8. Suggested PR sequence after this plan merges

1. **Spike PR** (closes or advances #416) — real traces + A/B/C decision only.
2. **Implementation PR** (closes #96) — follows the chosen contract, TDD, qualification, docs.

## Agent pickup note

Prefer the provider’s richest stable native integration contract. Agent Bridge stitches Grok Build into durable Run and delivery semantics; it does not rebuild the Grok harness. Do not implement production code until #416 records an explicit ACP / headless / not-ready decision with sanitized traces.
