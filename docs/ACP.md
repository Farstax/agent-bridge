# ACP provider-runtime boundary

Agent Bridge uses Agent Client Protocol (ACP) v1 as the canonical inward
provider-runtime contract for providers that have completed ACP migration.
This is not a second agent runtime and not a proprietary wrapper around ACP.

Pinned SDK: `@agentclientprotocol/sdk@1.4.0` (stable ACP v1 entry point).
Pinned Codex ACP adapter: `@agentclientprotocol/codex-acp@1.10.0`
(maintained implementation; bundled in the active Agent Bridge release).
Pinned Claude ACP adapter: `@agentclientprotocol/claude-agent-acp@0.76.0`
(official Registry distribution; bundled in the active Agent Bridge release).
Pinned Grok ACP distribution: `@xai-official/grok@1.0.30` (`grok agent stdio`;
official Registry `grok-build` 1.0.30). The package bin symlink is rewritten
to a relative `grok-native` link at install so release artifacts stay
self-contained.
Pinned Agy ACP distribution: official Registry `antigravity-acp@1.1.1`
(`agy_acp_server.par` with args `--uid=`). The binary is not npm-bundled;
ordinary Runs never download it. Set `AGY_ACP_COMMAND` to the installed
server path.
Pinned Cursor ACP distribution: official Registry `cursor` 2026.09.08-6caf4ff
(`cursor-agent acp`; binary 2026.09.08-6caf4ff). The Cursor CLI is not
vendored into git or npm; ordinary Runs use `CURSOR_ACP_COMMAND` or PATH
`cursor-agent`.

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

## Canonical ACP provider onboarding

A straightforward Registry-listed ACP provider should require only:

1. an Agent Bridge provider id;
2. an ACP Registry agent id and exact release-locked qualified distribution/version;
3. small provider policy hooks only for genuine auth, authority, configuration,
   error, or presentation differences; and
4. provider qualification.

It should not require a provider-specific runtime, parser, session, doctor,
qualification, or messaging module. Runtime lifecycle, replay, cancellation,
completion, telemetry, redaction, supervision, and session mapping belong to
the shared ACP path.

If an ACP agent is absent from the public Registry, a release may own a narrow
launch override, but it must feed the same generic ACP runtime rather than
creating a parallel provider-extension system. Mutable Registry latest is
never resolved during an ordinary Run.

## Codex runtime

Codex runs through the managed ACP adapter. There is no native `codex exec`
execution path or ACP-vs-legacy runtime selector.

```bash
CODEX_ACP_COMMAND=...               # optional override of the bundled adapter
CODEX_ACP_ARGS=...                  # optional extra adapter argv
```

The pinned adapter ships with the Agent Bridge release as
`@agentclientprotocol/codex-acp@1.10.0`. Fresh managed installation and
source `npm install` both obtain it. Execution, doctor, health, qualification,
and runtime inspection resolve the same launchable artifact:

`$BRIDGE_CURRENT_RELEASE_DIR/node_modules/.bin/codex-acp`

Set `CODEX_ACP_COMMAND` only to override that bundled path. There is no
silent fallback to `codex exec` if the adapter is missing. Managed install
and upgrade preserve `CODEX_ACP_COMMAND` and `CODEX_ACP_ARGS` when configured.

## Claude runtime

Claude uses the same managed ACP lifecycle as Codex. There is no native
Claude stream-json invocation or parser path.

```bash
CLAUDE_ACP_COMMAND=...              # optional override of the bundled adapter
CLAUDE_ACP_ARGS=...                 # optional extra adapter argv
```

The release owns `@agentclientprotocol/claude-agent-acp@0.76.0` and resolves
the default executable as
`$BRIDGE_CURRENT_RELEASE_DIR/node_modules/.bin/claude-agent-acp`. Session
mode stays `default` for safe and trusted runs because Agent Bridge answers
ACP permission requests. Claude setting sources are disabled for every
Bridge run so local allow rules cannot bypass that authority. Strict
tool-free runs also disable built-in tools, external MCP configuration, and
all configured tools through Claude ACP session metadata.

## Grok runtime

Grok uses the same managed ACP lifecycle as Codex and Claude. There is no
native `grok -p --output-format streaming-json` invocation or parser path.

```bash
GROK_ACP_COMMAND=...                # optional override of the bundled CLI
GROK_ACP_ARGS=...                   # optional extra argv; default is `agent stdio`
```

The release owns `@xai-official/grok@1.0.30` (Registry `grok-build` 1.0.30)
and resolves the default executable as
`$BRIDGE_CURRENT_RELEASE_DIR/node_modules/.bin/grok` with args `agent stdio`.
Ordinary Runs authenticate with ACP `cached_token` from workspace-local
`~/.grok/auth.json`. `XAI_API_KEY` remains a workspace-local alternative and
is verified with a bounded ACP probe. Steering is not enabled.

## Agy runtime

Agy uses the same managed ACP lifecycle as Codex and Claude. There is no
native `agy --print --output-format stream-json` invocation, parser, planner
stall watch, or settings.json model writer.

```bash
AGY_ACP_COMMAND=...                 # optional override; default is agy_acp_server.par
AGY_ACP_ARGS=...                    # optional extra argv; default is --uid=
```

The release locks official Registry `antigravity-acp@1.1.1`. The binary is
host-installed, not npm-bundled; ordinary Runs never download it. Ordinary
Runs authenticate with ACP `oauth-personal` only when a cached credential
already exists at workspace-local `~/.gemini/antigravity-acp/acp_token.json`
(a separate credential tree from native Agy/`antigravity-cli`'s
`~/.gemini/oauth_creds.json`); Agent Bridge never triggers the interactive
Google OAuth browser flow during an ordinary Run, and does not invent
`GEMINI_API_KEY`. Steering is not enabled. Native Agy advertised tool-free
execution, and the generic ACP policy keeps that advertisement.

## Cursor runtime

Cursor uses the same managed ACP lifecycle as Codex and Claude. There is no
native `cursor-agent -p --output-format json` invocation or parser path.

```bash
CURSOR_ACP_COMMAND=...              # optional override of PATH `cursor-agent`
CURSOR_ACP_ARGS=...                 # optional extra argv; default is `acp`
```

The release locks official Registry `cursor@2026.09.08-6caf4ff` (binary archive
`2026.09.08-6caf4ff`) and resolves the default executable as `cursor-agent`
with args `acp`. Ordinary Runs authenticate with ACP `cursor_login` only when
a cached Cursor login already exists at workspace-local
`~/.config/cursor/auth.json` or `~/.cursor/auth.json` --
`authenticate({methodId:"cursor_login"})` blocks indefinitely with no cached
login, so Agent Bridge never triggers it during an ordinary Run. Cached
account login is authoritative over an optional, unverified `CURSOR_API_KEY`
(same account-auth precedence as Grok). Safe runs select the advertised `ask`
mode and trusted runs select `agent`; the policy does not assume a provider
default. The selected executable is version-checked against the locked
`2026.09.08-6caf4ff` release before routing and before execution, so a stale or
unverifiable `cursor-agent` fails closed. The official binary distribution is
recorded in the Registry lock; Agent Bridge does not download or vendor that
archive.

## Process lifecycle

ACP stdio children use `cliSupervisor.runSupervisedStdioSession()`. That
reuses child ownership, workspace locking, timeouts, idle timeout, `/stop`,
hard cancellation, fencing, env scrubbing, redaction, and shutdown cleanup.
Stdout on this path is ACP JSON-RPC, not user-visible text. Successful
prompts do not call `session/close`; the provider ACP session id is a durable
resume handle. Child-process teardown still kills the stdio agent.

An ACP agent can also resolve a prompt gracefully with `stopReason:
"cancelled"` (e.g. after `session/cancel`) without the child dying — the
Bridge process fence never fires and the ACP session stays live. `CliResult`
carries the raw ACP `stopReason` so `BridgeEngine` can tell this apart from a
normal completion: a cancelled turn is never delivered, never published as
output, and never remembered as a completed conversation turn, even if it
carries partial text. The durable Run becomes `run.cancelled` (reason
`"provider"`), the ACP session id is still persisted so the next turn in the
conversation can resume it, and the input message is retired (not requeued)
since the provider already consumed it. This is a distinct path from Bridge's
own `/stop`, which kills the child process instead.

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
`_meta.codex.phase` (`"commentary"` | `"final_answer"`), set on the update
payload itself (`notification.update._meta`, via ACP's `ContentChunk`) — not
on the `SessionNotification` envelope (`notification._meta`), which is a
structurally distinct field ACP reserves for its own extensibility metadata.
That interpretation is Codex-specific and lives in `codexAcpPolicy.ts`, not
the generic ACP core: commentary remains available as live intermediate
progress, but the authoritative delivered answer excludes it, along with any
chunk with a missing or unrecognized phase value once a turn has shown any
Codex phase metadata at all (fail closed rather than leak commentary/unknown
text as if it were the answer). Agents that supply no phase metadata for the
whole turn are unaffected — every live chunk is part of the answer, as
before.

## Client capabilities

Initialize advertises only the client capabilities Agent Bridge actually
needs: `plan: {}`, since Bridge retains structured plan updates as part of
rich ACP event retention. Filesystem and terminal client methods are not
advertised; the provider agent keeps those tools. Permission requests are
mapped onto Bridge `safe` / `trusted` execution authority. For Codex, `safe` selects the
Codex ACP `read-only` agent mode (`approvalsReviewer: "user"` — every
mutation/network request is routed back through Bridge's own permission
decision) and `trusted` selects `agent-full-access`. Codex ACP's `agent` mode
is never selected for a Bridge-mediated turn: it uses an `auto_review`
approvals reviewer that lets the adapter self-approve actions it judges safe
without ever asking Bridge, which would silently expand the provider's
authority underneath Bridge's own policy.

Outbound prompt content is checked against the agent's negotiated
`agentCapabilities.promptCapabilities` before dispatch. Text is always
baseline-supported. An image/audio/embedded-resource block the agent did not
negotiate fails closed with a precise error before the prompt is sent,
rather than silently dropping the attachment.

## Tool-free execution

Codex ACP's `read-only` agent mode is not equivalent to strict tool-free execution: it still permits read/search/think-style tools and only
restricts mutation/network authority. The pinned adapter has no config knob
that guarantees genuinely tool-free execution, so Codex provider policy fails
closed (`CodexAcpToolFreeUnsupportedError`) for `toolMode: "none"` rather than
silently weakening Advisor's tool-free contract to read-only.

Claude ACP supports strict tool-free execution through its provider metadata.
Agent Bridge supplies an empty tool set, disables built-in tools and setting
sources, clears MCP servers, and enables strict MCP configuration.

## Non-goals

- Remote HTTP/WebSocket ACP transport
- Migrating Agy, Cursor, or Grok in this phase
- Changing Telegram/Discord presentation to show tool calls or plans
- Remote interactive authentication UI. Provider API-key authentication uses
  the ACP authenticate method when configured; existing provider-local login
  state remains available to the managed adapter.
