# Development Practice — Red-Green-Refactor TDD

**All implementation work uses red-green-refactor TDD. No exceptions.**

1. **Red** — write a failing test that describes the desired behaviour before touching production code.
2. **Green** — make the smallest change that passes the test.
3. **Refactor** — clean up with tests green.

By work type:
- **Feature:** write the first acceptance or unit test before implementation.
- **Bug fix:** reproduce with a failing regression test before fixing.
- **Refactor:** add characterization tests that lock existing behaviour before restructuring.

## Verification protocol — do this every cycle

Use focused red/green locally; exact-head GitHub CI owns the required full-suite regression gate.

```bash
# After writing tests, before writing implementation:
npm test -- <focused-test-file-or-pattern>   # new test(s) must FAIL — confirm red

# After writing implementation:
npm test -- <focused-test-file-or-pattern>   # focused affected set must PASS — confirm green
```

If you cannot confirm the red state, stop. The test is either wrong, already covered, or testing nothing.

For green verification, rerun the same focused test plus directly affected boundary tests. Add broader local tests, typecheck, architecture/static checks, or build checks when the touched boundary and risk justify them.

Do not rerun the full suite locally by default. Run local `npm test` only when the change is intentionally broad/global, exact-head GitHub CI is unavailable, or a CI/review failure needs full-suite reproduction. Before merge, the current PR head must have a successful full `npm test` in GitHub `CI` plus the repository's other required exact-head checks. A head SHA change invalidates that evidence and requires fresh CI.

Independent review should use current exact-head GitHub CI as the full-regression evidence and run only focused tests needed to investigate findings. If a review repair changes code, require fresh exact-head CI rather than reproducing the whole suite locally first.

## Commit discipline

**Tests and implementation must be separate commits.** Never bundle them together.

```
commit 1: test: add failing tests for <feature>    ← red state
commit 2: feat/fix: implement <feature>            ← green state
```

The commit history must prove that the test existed before the implementation. A single commit containing both test and production code is not TDD — it is tests-alongside-code with no proof of the red state.

Planning note: when writing or reviewing an implementation plan, ensure every phase explicitly requires:
1. Write focused test → run focused test → confirm red → commit
2. Write implementation → rerun focused affected tests → confirm green → commit
3. Push the final head → require exact-head GitHub CI and other required checks before merge

---

# Persistent memory

Bridge-spawned agents receive `AGENT_BRIDGE_CONTEXT_COMMAND` when shared
project memory is available.

Before making architectural decisions or modifying important behaviour, use:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-query "<short relevant query>"
```

When you learn a durable project fact, decision, bug fix, convention, or
recurring issue, write a guarded candidate with:

```bash
"$AGENT_BRIDGE_CONTEXT_COMMAND" --memory-add-json '{"type":"decision","scope":"project","text":"<concise memory>","confidence":0.8}'
```

Do not save secrets, API keys, passwords, transient logs, or private personal
information.

---

# Service Restart Safety

**Never trigger direct `sudo systemctl restart agent-bridge-<bot>` from within an active bot session.**

When a direct restart command runs inside a bot session, systemd sends SIGTERM
to the entire service control group, including the currently-running CLI
process. That kills the session issuing the restart before it can report the
result.

Approved restart paths:

1. From outside any active bot session, use direct restarts:

```bash
sudo systemctl restart agent-bridge-antigravity
sudo systemctl restart agent-bridge-codex
sudo systemctl restart agent-bridge-claude
```

2. From inside an active bot session, use the narrow safe restart helper. It
   sleeps for 5 seconds before restarting services, giving the bridge time to
   send the final Telegram reply:

```bash
sudo -n /usr/local/sbin/restart-agent-bridge
```

The helper must be root-owned and granted via a narrow sudoers rule for only
`/usr/local/sbin/restart-agent-bridge`. Do not grant `NOPASSWD: ALL` or raw
passwordless `systemctl`. Do not use the helper for destructive operations or
worker deploys that need drain semantics; worker restarts that may interrupt
active jobs still require the worker-specific drain flow.

If the bot becomes unresponsive after a bad restart, send `/reset` to the affected bot on Telegram to clear any stale execution lock.

---

# CLI Effort Policy

Supported effort levels are `low`, `medium`, `high`, `xhigh`, and `max`;
default is `medium`. `/effort` changes the interactive setting.

- Codex maps effort to `-c model_reasoning_effort="<level>"`
- Claude maps effort to `--effort <level>`
- Agy has no separate effort flag; the bridge stores/displays the setting only
  so the unsupported state is explicit. Use Agy model labels for low/high.

Worker jobs select effort by task: scribe/read-only jobs use `medium`;
`tdd_implementation` and `orchestrated_task` use `high`.

---

# Autonomous Worker Loop — invariants

When working on the worker lane (`src/index-worker.ts`, `src/jobExecutor*.ts`,
`src/handlers/`, `src/workspace.ts`, `src/prMergeGate.ts`, `src/workCallbacks.ts`):

- Implementation jobs run **only in per-job workspace clones** (`src/workspace.ts`),
  never in live checkouts or the worker's cwd. Workspace cleanup must stay
  restricted to `$WORKER_WORKSPACE_DIR`.
- The TDD handler enforces the red/green split mechanically: red commits stage
  test files only and the red run must fail; green commits must not touch test
  files and verification must pass. Do not weaken these guards.
- The merge gate verifies head SHA and CI checks via `gh pr view` before any
  merge. Never add a merge path that skips it. Approvals stay pending on every
  blocked path, and every Telegram callback must be answered.
- Jobs with unregistered task types fail permanently — never leave them
  pending (head-of-line blocking).
- `cancelWorkJob` is final; complete/fail must not overwrite `cancelled`.
- Child processes in the worker use the async runner (`src/runCommandAsync.ts`)
  — no `execFileSync` in the polling process.
- New job-queue Telegram output: messages go through `sendTelegramMessage`,
  message edits through the entity-converting helper in `src/workCallbacks.ts`
  (raw `**`/backticks must not reach Telegram).

User guide: `docs/WORKER-GUIDE.md`. Phase 9 plan:
`docs/autonomous-agent-bridge-research.md`.

---

# Health Monitoring System

**Active** — enabled via `HEALTH_MONITOR_ENABLED=true` in `.env.shared` or `.env.health`.

A `HealthScheduler` runs alongside the bots and fires registered `HealthPlugin` instances on a `setInterval`. Key facts for working on this codebase:

- **`src/health/`** — types, reporter, scheduler, suggest, plugins/self, plugins/server, plugins/external
- **`SelfPlugin`** — always registered; checks DB file + read liveness
- **`ServerPlugin`** — checks CPU load, RAM/Swap, zombie processes, system uptime, and security posture (UFW status, SSH key permissions, environment file permissions)
- **`ExternalPlugin`** — spawns any shell command asynchronously with a timeout, parses stdout as `HealthReport` JSON
- **`generateSuggestion`** (suggest mode) — routes through `buildCliInvocation → runCli → parseCliResult`, same path as real user messages. Bot selected by `HEALTH_SUGGEST_BOT` env var. Filters error-shaped responses.
- **`_suggestFn` injection** — `HealthScheduler` constructor accepts `_suggestFn` to replace `generateSuggestion` in tests, avoiding real CLI spawning under fake timers
- **`silenceOnGreen`** — `HealthConfig.silenceOnGreen?: boolean` suppresses `sendReport` calls when `report.status === "green"`. The `HealthBridgeBot.handleReport` path already silences green by default; this flag brings scheduler-direct callers into line.
- **Content-crawler POC** — `~/content-crawler/scripts/health_check.py`; checks queue depth, failed items, stale workers, signal-feed age, disk space; enabled via `HEALTH_CONTENT_CRAWLER_ENABLED=1`

When modifying the health module, keep `_suggestFn` injectable — do not inline `generateSuggestion` in the scheduler.

---

# Image Generation

Use the **Agy (Gemini) CLI** for all image generation — not the raw `gemini` command invoked without context. Agy runs from its configured project directory with the correct settings, producing faster and more reliable results.

**Invocation pattern:**

```bash
GEMINI_CLI_PATH=/home/content-crawler/.nvm/versions/node/v24.15.0/bin/gemini

$GEMINI_CLI_PATH -y -p "Generate a photorealistic image of <description>. Use Imagen to generate directly — do not fetch from the web. Save the result as <output_path>."
```

**Key rules:**
- Always include `"Use Imagen to generate directly — do not fetch from the web."` to prevent the Unsplash/web-fetch detour.
- Save output to the user's bridge output dir: `/tmp/bridge-out/claude-<chatId>/`
- Run the command as a **background process** (`run_in_background: true`) then wait for the task notification before reporting.
- Verify the file exists and is a valid image (`file <path>`) before reporting success.
- Do not mention the output path in the Telegram response — the bridge delivers the file automatically.
