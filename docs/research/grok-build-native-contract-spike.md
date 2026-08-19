# Grok Build native contract spike (#416) — partial evidence

**Status:** Blocked on authentication for full probe matrix.  
**Grok Build version:** `grok 1.0.5 (5115b46bc9)` (linux-x86_64, installed 2026-08-19 via `https://x.ai/cli/install.sh`)  
**Decision:** **not yet** — cannot recommend A/B/C until authenticated headless + ACP success-path traces exist.

Related plan: `docs/roadmap/issue-96-grok-build-integration-plan.md` (PR #497).

---

## 1. Phase 0 inspection (completed)

### 1.1 Version

```text
grok 1.0.5 (5115b46bc9)
```

### 1.2 Headless contract (from `--help`)

- Headless entry: `-p, --single <PROMPT>` — single-turn prompt, print response, exit.
- Output formats: `plain` (default), `json`, `streaming-json` (NDJSON of native ACP session updates), `streaming-messages-json`.
- Session: `-r/--resume [ID_OR_TITLE]`, `-c/--continue`, `-s/--session-id` (new UUID only; does not resume), `--fork-session`.
- Permissions: `--always-approve`, `--permission-mode` (`default|acceptEdits|auto|dontAsk|bypassPermissions|plan`), `--allow` / `--deny`.
- Other: `--cwd`, `--max-turns`, `--model`, `--no-subagents`, `--sandbox`.

Local docs also shipped under `~/.grok/docs/user-guide/14-headless-mode.md` and `15-agent-mode.md`.

### 1.3 ACP contract (from `grok agent --help` + live `initialize`)

- Transports: `stdio`, `serve`, `headless` (WS relay), `leader`.
- Flags: `--always-approve`, `-m/--model`, `--reauth`, `--agent-profile`, `--leader` / `--no-leader`.

**Live `initialize` result (unauthenticated process still answers RPC):**

- `protocolVersion: 1`
- `agentCapabilities.loadSession: true`
- `sessionCapabilities`: `list`, `resume`, `close` present
- `promptCapabilities`: `embeddedContext: true`; image/audio false on this build
- Auth methods advertised: `[{ id: "grok.com", name: "Grok", ... }]`
- `_meta.agentVersion: "1.0.5"`, default model catalog includes `grok-4.6` / `grok-4.5` with reasoning effort levels
- xAI extensions referenced in capabilities (hooks, fs_notify, tool overrides, etc.)

**Capability discovery is rich enough to fail closed on missing features** for session load/resume flags reported at initialize time. Full drift policy still needs authenticated multi-event traces.

### 1.4 Official docs reviewed

- Installed: `~/.grok/docs/user-guide/14-headless-mode.md`, `15-agent-mode.md`
- Upstream (same content family): xai-org/grok-build user-guide headless + agent-mode pages

---

## 2. Unauthenticated probes (completed)

### 2.1 Headless — auth failure path

Command:

```bash
grok -p "Reply with exactly the word PONG and nothing else." \
  --output-format streaming-json --always-approve --cwd /tmp/grok-spike
```

**Stdout (only line):**

```json
{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser."}
```

**Exit code:** `1` (confirmed for `streaming-json`, `json`, `plain`).

**Bridge relevance:**

- Structured `type:error` on stdout is parseable without heuristics.
- Failure is **bounded** (seconds, not interactive hang) when no TTY login is attempted.
- Supports #96 acceptance: missing auth must fail boundedly without waiting for interactive login — **this path already matches** for headless when credentials are absent.

Not yet proven: successful `text` / `thought` / tool / `end` event shapes, resume, cancel mid-stream, long answer.

### 2.2 ACP — initialize + session/new without auth

1. `initialize` → **success** (capabilities + authMethods), process stays up.
2. `session/new` with `cwd` + `_meta.yoloMode` → **JSON-RPC error**:

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required","data":"no auth method id provided"}}
```

3. No `sessionId` issued → prompt not attempted.

**Bridge relevance:**

- ACP is truly duplex and long-lived (stdio process).
- Auth is enforced at **session create**, not at process start — client must not treat `initialize` success as “ready to Run”.
- Error is typed JSON-RPC (code `-32000`), suitable for `auth_required` classification without scraping TTY prompts.
- Confirms plan P1: ACP **cannot** be driven solely via one-shot `runSupervisedProcess` stdin-close-exit.

Not yet proven: session/new after auth, prompt streaming, `agent_message_chunk` vs `agent_thought_chunk`, load/resume after restart, cancel, tools, subagents, long answer, latency.

---

## 3. Remaining #416 work (blocked)

Requires **one** of:

- `XAI_API_KEY` in the environment, or
- `grok login --device-code` completed on this host, or
- equivalent non-interactive auth the operator trusts for spike-only use

Then run the full matrices from #416:

**Headless:** fresh short answer; resume with session ID from `end`; tool use; reasoning/answer separation; SIGINT/SIGTERM cancel; error path (done partially); long answer; measure first `text` vs terminal `end`.

**ACP:** initialize + session/new (auth); short prompt; message chunk ordering; thought separation; tool call cycle; session load/resume after process restart; cancel; long answer; failure; native subagent if present; measure first eligible chunk latency.

**Compare** only the nine dimensions in #416; answer process-lifecycle for ACP; emit A / B / C.

---

## 4. Preliminary observations (not a decision)

| Topic | Observation |
|-------|-------------|
| Headless fit to Bridge one-shot seam | Strong candidate: `-p` + `streaming-json` + exit + structured error already align with `runSupervisedProcess`. |
| ACP fit | Confirmed long-lived duplex; needs Grok-owned client (plan Phase 3B). |
| Auth failure | Both surfaces fail closed without interactive hang in this environment. |
| Streaming safety | **Unproven** until success-path traces show only `text` / `agent_message_chunk` are answer-eligible. |
| Recommendation | **Withheld** until authenticated probes complete. |

---

## 5. Sanitized artifacts location (spike host)

```text
/tmp/grok-spike/headless/   # stdout/stderr samples
/tmp/grok-spike/acp/        # stdio stderr + handshake captures
```

No secrets were present; outputs contain only not-signed-in messages and capability metadata.

---

## 6. Next action

1. Operator supplies non-interactive auth for this environment.  
2. Re-run full #416 probe matrix.  
3. Replace this document’s status with complete traces + **A / B / C**.  
4. Only then start #96 implementation per the integration plan.
