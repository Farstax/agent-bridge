# ACP provider-runtime boundary

Agent Bridge uses Agent Client Protocol (ACP) v1 as the future
provider-runtime contract. This is not a second agent runtime and not a
proprietary wrapper around ACP.

Pinned SDK: `@agentclientprotocol/sdk@1.4.0` (stable ACP v1 entry point).
Pinned Codex ACP adapter: `@agentclientprotocol/codex-acp@1.10.0`
(maintained implementation; bundled at `$BRIDGE_PROJECT_DIR/node_modules/.bin/codex-acp`).

## Ownership

1. **Agent Bridge owns** durable Run/conversation identity, routing and
   fallback, queues and interrupt admission, `/stop`, cancellation and
   fencing, workspace locking, authority/policy, routines, context/soul
   policy, Telegram/Discord delivery, health, and Bridge-level telemetry.
2. **ACP owns** agent communication: initialize, session lifecycle, prompt,
   `session/update`, cancel, stop reason, usage, and permission requests.
3. **The provider agent owns** reasoning, tools, and native provider session
   state.

Do not use a provider ACP session ID as Agent Bridge's durable identity.
The mapping is:

`Bridge conversation/run identity -> provider ACP session ID`

It is persisted in `acp_session_bindings` (schema 16) so fresh sessions,
resumed sessions, Bridge restart, and later provider handoff keep the
outward conversation identity stable.

`acp_session_bindings` follows the same seven-day stale-session policy as
legacy provider sessions (`bridge_state`), keyed by `updated_at` (last
successful use) rather than creation time. A binding untouched for seven
days is cleared on the next database open; only the stale native-resume
pointer goes away, Bridge conversation identity is untouched, and the next
turn starts a fresh ACP session automatically.

## Codex selection

The existing `codex exec --json` runtime remains the default.

```bash
AGENT_BRIDGE_CODEX_RUNTIME=legacy   # default
AGENT_BRIDGE_CODEX_RUNTIME=acp      # parallel ACP-backed Codex path
CODEX_ACP_COMMAND=...               # optional override of the bundled adapter
CODEX_ACP_ARGS=...                  # optional extra adapter argv
```

The pinned adapter ships with the Agent Bridge release as
`@agentclientprotocol/codex-acp@1.10.0`. Fresh managed installation and
source `npm install` both obtain it. The runtime, doctor, qualification,
and inspector resolve the same launchable artifact:

`$BRIDGE_PROJECT_DIR/node_modules/.bin/codex-acp`

Set `CODEX_ACP_COMMAND` only to override that bundled path. There is no
silent fallback to `codex exec` if the adapter is missing.

Managed install and upgrade carry `AGENT_BRIDGE_CODEX_RUNTIME`,
`CODEX_ACP_COMMAND`, and `CODEX_ACP_ARGS` through the service environment
when they are configured. Rollback to legacy is `AGENT_BRIDGE_CODEX_RUNTIME=legacy`
(or unset). Selection is explicit. There is no silent fallback between the
two Codex implementations inside one attempt.

## Process lifecycle

ACP stdio children use `cliSupervisor.runSupervisedStdioSession()`. That
reuses child ownership, workspace locking, timeouts, idle timeout, `/stop`,
hard cancellation, fencing, env scrubbing, redaction, and shutdown cleanup.
Stdout on this path is ACP JSON-RPC, not user-visible text. Successful
prompts do not call `session/close`; the provider ACP session id is a durable
resume handle. Child-process teardown still kills the stdio agent.

## Replay and delivery

`session/load` may replay historical `session/update` events. Replay is
marked internally and is not live Telegram/Discord output. Chat surfaces
continue to receive only the current turn's live agent text. Rich ACP tool,
plan, permission, and usage events are retained internally as durable
`acp.event` Bridge events (`bridge_events`), one row per ACP event, forwarded
as each event arrives rather than batched at successful turn completion — so
events observed before a cancellation, timeout, provider error, or child
death are still persisted. Permission events retain the actual request and
Bridge's decision, not merely that a permission event happened. Provider
credentials are redacted from every retained event (including tool
`rawInput`/`rawOutput`) before it is persisted, the same contract already
applied to delivered text.

Codex ACP additionally tags `agent_message_chunk` updates with
`_meta.codex.phase` (`"commentary"` | `"final_answer"`). That interpretation
is Codex-specific and lives in `codexAcpRuntime.ts`, not the generic ACP
core: commentary remains available as live intermediate progress, but the
authoritative delivered answer excludes it. Agents that supply no phase
metadata are unaffected — every live chunk is part of the answer, as before.

## Client capabilities

Initialize advertises only the client capabilities Agent Bridge actually
needs: `plan: {}`, since Bridge retains structured plan updates as part of
rich ACP event retention. Filesystem and terminal client methods are not
advertised; the provider agent keeps those tools. Permission requests are
mapped onto Bridge `safe` / `trusted` execution authority.

Outbound prompt content is checked against the agent's negotiated
`agentCapabilities.promptCapabilities` before dispatch. Text is always
baseline-supported. An image/audio/embedded-resource block the agent did not
negotiate fails closed with a precise error before the prompt is sent,
rather than silently dropping the attachment.

## Tool-free execution

Legacy Codex `toolMode: "none"` explicitly disables shell, browser, computer
use, plugins, hooks, goals, and apps. Codex ACP's `read-only` agent mode is
not equivalent: it still permits read/search/think-style tools and only
restricts mutation/network authority. The pinned adapter has no config knob
that guarantees genuinely tool-free execution, so `buildInvocation` fails
closed (`CodexAcpToolFreeUnsupportedError`) for `toolMode: "none"` rather than
silently weakening Advisor's tool-free contract to read-only.

## Non-goals

- Remote HTTP/WebSocket ACP transport
- Farstax outward ACP exposure
- Migrating Claude, Agy, Cursor, or Grok in this phase
- Removing the legacy Codex runtime
- Changing Telegram/Discord presentation to show tool calls or plans
- A full interactive ACP `authenticate` handshake. When `CODEX_API_KEY` is
  present, the ACP child sets `DEFAULT_AUTH_REQUEST={"methodId":"api-key"}`
  so the adapter uses the same workspace-local key as `codex exec`. ChatGPT
  login already stored in `~/.codex` remains sufficient without that env.
