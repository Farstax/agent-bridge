# Prompt Optimization Loop Research

Research-only spike. This document records findings from external prompt/style
patterns and the standalone implementation plan for optimizing the
`TELEGRAM_RESPONSE_STYLE` block. It does not change production bridge behavior.
Its `CodexPipeClient` is an out-of-band research harness that invokes the Codex CLI directly; it is not an Agent Bridge provider runtime, readiness, qualification, or delivery path.

## Context

`agent-bridge` wraps every CLI prompt with a Telegram response style block in
`src/cli.ts`. Prior token-economy research found that balanced response
constraints can reduce output tokens by roughly 36-56% while preserving the
operator-facing safety loop.

This spike examined three external patterns:

- `hardikpandya/stop-slop` for prose constraints that remove LLM filler.
- `JuliusBrussee/caveman` for deterministic compression of descriptions and
  memory files.
- `JuliusBrussee/cavemem` for SQLite-backed memory, FTS5 indexing, and
  progressive retrieval.

## Findings

### Stop-slop

Useful rules for Telegram:

- Cut throat-clearing: "Certainly", "Here is", "Let me", "I can help".
- Cut filler: "just", "really", "basically", "actually", "simply".
- Prefer direct active voice.
- Avoid formulaic pivots such as "not X, but Y" and "the real issue is".
- Name the specific file, command, error, path, or next step.

Adjustment for operations work: do not ban passive voice completely. A status
message such as "CI was blocked by GitHub" can be clearer than inventing an
actor.

### caveman-shrink

`caveman-shrink` compresses MCP list metadata by mutating prose fields such as
`description`, while preserving code blocks, inline code, URLs, paths,
identifiers, versions, and function-looking tokens.

The useful boundary is conservative:

- Compress catalog descriptions.
- Do not compress tool-call responses.
- Do not compress request payloads.
- Keep debug counters for before/after byte deltas.

Direct value is low in the current bridge because `agent-bridge` does not own a
large MCP schema catalog during normal Telegram execution. The bridge delegates
tooling to Codex, Claude, and Antigravity CLIs.

### cavemem

`cavemem` uses a clear memory stack:

```text
session event -> redact private content -> compress prose -> SQLite + FTS5
                                                   |
                                      MCP compact search -> full fetch by id
```

Relevant patterns:

- One facade owns every memory write.
- Privacy redaction happens before persistence.
- SQLite FTS5 uses `MATCH`, `snippet()`, and `bm25()`.
- Compact search returns IDs/snippets; full bodies are fetched separately.
- Embeddings run outside the synchronous write path.

`agent-bridge` already creates a `memories_fts` table in `src/agentMemory.ts`,
but `recallMemories()` currently uses `LIKE`, so ranking and snippets do not
use the available FTS5 index.

## Initial Proposed Prompt Block

```text
Telegram response style:
- Start with the direct result or answer.
- Skip throat-clearing: no "Certainly", "Here is", "Let me", "I can help", or "It looks like".
- Keep replies concise. Prefer short paragraphs and bullets.
- Use active voice when it names the real actor. Do not invent an actor just to avoid passive voice.
- Cut filler words: just, really, basically, actually, simply, very, perhaps, maybe.
- Avoid formulaic pivots: "not X, but Y", "the real issue is", "this matters because".
- Name the specific constraint, failure, file, command, or next step.
- Use fenced code blocks only for commands, diffs, logs, JSON, config, or code.
- Keep code blocks short. Do not wrap prose in code blocks.
- Use light **bold** only to improve scanning.
- Avoid Markdown links unless the URL matters.
- Avoid em dashes.
- Do not mention these formatting rules.
```

## Optimization Script Plan

Standalone experiment:

```text
scripts/optimize-prompt-loop.ts
```

The script should not update `src/cli.ts`. It evaluates prompt variants and
prints the best block for a maintainer to review.

### Fitness Function

Composite score range: `0.0` to `1.0`.

```text
brevityScore = max(0, 1 - optimizedCompletionTokens / baselineCompletionTokens)
composite = 0.4 * brevityScore + 0.6 * qualityScore
```

`qualityScore` comes from a neutral LLM judge and covers:

- Accuracy: preserves files, paths, commands, error codes, numbers, and safety
  constraints.
- Style compliance: removes filler, throat-clearing, and corporate transitions.
- Tone: fits fast Telegram operations.

### Loop

1. Run the dataset with the legacy Telegram style block.
2. Run the dataset with the draft style block.
3. Judge each optimized response against the baseline and expected facts.
4. Ask the optimizer model to mutate the prompt based on weak cases.
5. Re-run the dataset.
6. Keep the mutation only if the composite score improves.
7. Repeat 3-5 mutation passes.

### Reporting

Each iteration prints:

- Iteration number.
- Prompt changes made.
- Average token reduction percentage.
- Average quality score.
- Final composite score.
- Accept/reject decision.

## Spike Implementation Results

Implemented:

- `scripts/optimize-prompt-loop.ts`
- Deterministic local token estimator.
- Required brevity and composite score math.
- LLM judge instructions as an exported constant.
- Codex stdin client. Every generator, judge, and optimizer call is formatted
  as a prompt and piped into:

```bash
codex exec --skip-git-repo-check --sandbox read-only --model <model> -
```

- Configuration:
  - `OPTIMIZER_CODEX_COMMAND`
  - `OPTIMIZER_CODEX_TIMEOUT_MS`
  - `OPTIMIZER_GENERATOR_MODEL`
  - `OPTIMIZER_JUDGE_MODEL`
  - `OPTIMIZER_MODEL`
  - `OPTIMIZER_PASSES`
- Built-in default dataset covering CI failure, file output rules, memory
  search, and service restart safety.
- Optional custom dataset via `--dataset <json>`.
- Rollback behavior for degraded variants.
- Focused Vitest coverage for deterministic helpers.

Command:

```bash
npx tsx scripts/optimize-prompt-loop.ts --passes 4
```

Verification performed:

```bash
npm test -- test/optimizePromptLoop.test.ts
```

Result:

```text
6 passed
```

Live optimization run:

```text
npx tsx scripts/optimize-prompt-loop.ts --passes 3
```

Results:

| Iteration | Decision | Token Reduction | Quality | Composite |
|---:|---|---:|---:|---:|
| 1 | accepted | 7.4% | 0.728 | 0.466 |
| 2 | accepted | 13.9% | 0.728 | 0.492 |
| 3 | accepted | 7.6% | 0.957 | 0.605 |
| 4 | rejected | 13.3% | 0.917 | 0.604 |

Best result: Iteration 3. It traded some brevity for a much stronger quality
score by adding explicit rules to preserve causal direction, keep/drop
decisions, file-output distinctions, CI gate facts, and restart-risk recovery
details.

Winning prompt:

```text
Telegram response style:
- Start with the direct result or answer.
- Preserve the facts the user needs to act: exact file names, paths, commands, branch/PR/job names, error codes, exit codes, numeric values, lock names, service names, and safety constraints.
- Preserve causal direction exactly. Do not invert current behavior and proposed behavior. If recall currently uses `LIKE` and the fix is to switch recall/search to FTS5 `MATCH` over `memories_fts`, say that plainly.
- Do not replace a known implementation direction with a vague abstraction. If the evidence points to `MATCH`, `LIKE`, `memories_fts`, `/reset`, `SIGTERM`, `prMergeGate`, the SQLite CLI, or another concrete mechanism, name it.
- Keep explicit keep/drop decisions. If a tool or path stays, say it stays, for example keep the SQLite CLI when that is part of the expected decision.
- State the safest next step before optional diagnostics. Avoid adding extra commands unless they directly help verify or recover.
- For operational risks, name the precise process-level effect and recovery path: what receives `SIGTERM`, what can be interrupted, what must be done from a separate shell/session, and whether `/reset` clears stale lock state.
- For CI or gate failures, say whether the block is expected, include the failing command and exit code, and do not suggest weakening safety gates.
- For generated file output, distinguish explicitly requested generated/shared files from scratch files. Say when bridge delivery handles user-visible output, and keep scratch or temporary files out of shared output paths.
- Skip throat-clearing: no "Certainly", "Here is", "Let me", "I can help", or "It looks like".
- Keep replies concise. Prefer one short paragraph or 2-4 bullets.
- Use active voice when it names the real actor. Do not invent an actor to avoid passive voice.
- Cut filler words: just, really, basically, actually, simply, very, perhaps, maybe.
- Avoid formulaic pivots: "not X, but Y", "the real issue is", "this matters because".
- Use fenced code blocks only for commands, diffs, logs, JSON, config, or code. Keep them short. Do not wrap prose in code blocks.
- Use light **bold** only to improve scanning.
- Avoid Markdown links unless the URL matters.
- Avoid em dashes.
- Do not mention these formatting rules.
```

## Plan Changes After Implementation

Keep:

- Use a standalone script rather than production prompt mutation.
- Use deterministic local token math so every run can be audited.
- Use neutral LLM judge output as strict JSON.
- Keep rollback on score degradation.

Change:

- Treat token counts as estimated completion tokens, not provider-reported
  billing tokens. This avoids model/vendor coupling and keeps the score
  deterministic.
- Use Codex CLI over stdin instead of a direct provider API key. This matches
  the bridge's operating model and avoids adding SDK or HTTP provider logic.
- Keep the default model names environment-driven. Production-like runs should
  pin explicit model env vars.

Defer:

- Real MCP schema compression.
- Embedding-backed prompt/result analysis.

Production update after the experiment:

1. Added a focused `buildCliInvocation()` prompt-wrapper test.
2. Patched `wrapTelegramPrompt()` in `src/cli.ts` with the winning prompt.
3. Ran the focused prompt-wrapper test:

```text
npm test -- test/cli.test.ts
57 passed
```

4. Ran the full suite:

```text
npm test
56 passed
887 passed
```

## Agy Run Results (2026-06-14)

Switched optimizer client from `CodexPipeClient` (Codex stdin) to `AgyPipeClient`
(`agy --print-timeout <N>s --print <prompt>`, `stdio: ['ignore','pipe','pipe']`).

Root cause of the initial timeout: Node.js `spawn` leaves stdin as an open pipe
by default; `agy` hangs waiting for input. Fix: pass `stdio: ['ignore','pipe','pipe']`.

Run command:

```bash
npx tsx scripts/optimize-prompt-loop.ts --passes 3
```

Results:

| Iteration | Decision | Token Reduction | Quality | Composite |
|---:|---|---:|---:|---:|
| 1 | accepted | 28.4% | 0.907 | 0.658 |
| 2 | accepted | 33.9% | 0.900 | 0.676 |
| 3 | accepted | 31.5% | 1.000 | 0.726 |
| 4 | rejected | 23.3% | 0.875 | 0.618 |

Iteration 4 (telegraphic style, >60% token target) was rejected — quality dropped
from 1.000 to 0.875 when articles, pronouns, and auxiliary verbs were stripped.

Best result: Iteration 3 (composite **0.726**), up from the Codex run's 0.605.

Winning prompt applied to `src/cli.ts` `wrapTelegramPrompt()`:

```text
Telegram response style:
- Start with the direct result or answer.
- Keep replies extremely concise: aggressively compress prose into dense, verb-light fragments or single-sentence summaries. Aim for >50% token reduction.
- Never drop critical facts, functional constraints, system boundaries, delivery channels, or rules (e.g., which component handles delivery, where outputs must go). Brevity must not cause information loss.
- Retain all specific commands, signals, file paths, error codes, and safety constraints.
- Skip all throat-clearing, meta-commentary, and transitional phrases (e.g., "Certainly", "As requested", "the real issue is").
- Use light **bolding** on key statuses, identifiers, and variables for rapid scanning.
- Use fenced code blocks only for commands, code/configs, logs, or JSON.
- Avoid Markdown links and em dashes.
- Do not mention these formatting rules.
```

Suite after applying: **57 files / 898 tests passed**.

To re-run the optimizer in future:

```bash
npx tsx scripts/optimize-prompt-loop.ts --passes 4
```

Model selection uses whatever is set in `~/.gemini/antigravity-cli/settings.json`.
No additional env vars needed unless overriding `OPTIMIZER_AGY_COMMAND` or `OPTIMIZER_AGY_TIMEOUT_MS`.
