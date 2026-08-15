# Companion Runtime Architecture

## Status

Canonical architecture documentation.

## Purpose

The Companion Runtime is the domain-agnostic conversational runtime inside Agent Bridge OSS.

It exposes one or more AI runtimes through chat or future TUI surfaces and manages conversation routing, sessions, fallback, memory use, and response delivery.

## Responsibilities

The Companion Runtime owns:

- Telegram conversational surfaces
- Discord conversational surfaces
- future chat/TUI transports
- conversation routing
- provider selection
- per-conversation session management
- usage monitoring
- provider/model fallback
- memory retrieval/write seams
- capability invocation through the Shared Runtime
- response rendering and delivery

## Frontier Advisor

The optional advisor lets a standard executor consult up to two ordered
frontier provider/model targets without changing its active provider or native
session. It is disabled by default.

- `manual`: explicit `/advisor ask|review|plan|debug` commands and direct agent
  calls through `AGENT_BRIDGE_ADVISOR_COMMAND` invoke the advisor.
- `suggest`: complex, risky, or stuck prompts pause for explicit approval.
- `auto`: those prompts consult the advisor and fold structured guidance into
  the executor prompt. Operational advisor failure is fail-open.

Fallback occurs only for authentication, capacity, unavailable model/provider,
timeout, transient failure, or invalid structured output. A valid opinion is
never retried merely because the executor disagrees. The advisor is trusted for
reasoning; merge, deploy, approval, deletion, final-message, and session
authority remain with Agent Bridge and its existing gates.

When agent-direct access is validly configured, bridge-spawned CLI agents
receive only `AGENT_BRIDGE_ADVISOR_COMMAND` and an opaque, expiring
`AGENT_BRIDGE_ADVISOR_CAPABILITY`. The prompt advertises this command:

```bash
"$AGENT_BRIDGE_ADVISOR_COMMAND" --mode review --task "Review this plan"
```

Supported agent modes are `plan`, `review`, `debug`, `risk`, and `decision`.
The helper sends only capability, mode, and task to a bridge-owned Unix-socket
broker. Scope, CLI identity, turn/task keys, repository path, enablement,
budgets, chain, executable, timeout, and database remain server-side. A new
turn revokes the previous capability; unused capabilities expire after ten
minutes. Provider children receive no advisor configuration or capability.

Every advisor entry point, including manual `/advisor` and agent
capability requests — resolves through one `AdvisorService` and its single
private execution path, under one `tool_free` execution profile. `/advisor`
and bounded evidence requests call `requestTrusted()` in-process; the Unix-socket
broker is only the untrusted cross-process adapter for CLI agents, and its
`requestWithCapability()` merely authenticates a capability and reconstructs
trusted scope before entering the same path. `tool_free` requires every chain
target to support verified tool-disabled execution: Claude runs with
`--tools ""`, while Codex and Agy fail closed until a verified
tool-disabled adapter exists. A two-model chain may use two Claude models.

### Configuration source and deployment drift

The running service process is authoritative. Under systemd, shared values are
loaded from `/etc/default/agent-bridge-shared` before the bot-specific defaults
file; a bot-specific value with the same key overrides the shared value.
Repository `.env.shared` is an editable source file, but changing it alone does
not update an already-running systemd service.

`/advisor status` reports the effective chain from the process environment. A
running process does not retain which environment file supplied a value, so the
status output separately lists readable configuration files whose chain matches
the effective value. It does not claim that a matching file was necessarily the
origin when the same value could also have come from a bot-specific override or
direct process environment.

When both repository `.env.shared` and `/etc/default/agent-bridge-shared` are
readable, the command compares the bounded `BRIDGE_ADVISOR_*` configuration keys
and emits a drift warning naming only the conflicting keys. It never displays
tokens, unrelated environment values, or file contents. If both files cannot be
read, drift is reported as not evaluated rather than as a false clean result.

After changing advisor configuration for a systemd deployment:

1. update `/etc/default/agent-bridge-shared` through the approved installer or
   deployment path;
2. run `systemctl daemon-reload` when unit files changed;
3. restart the affected Agent Bridge services;
4. run `/advisor status` and confirm the effective chain, matching files, and
   absence of drift warnings.

Unreadable or absent source files are reported only as unavailable evidence;
they do not create a false drift warning.

## Flow

```text
Transport
→ Conversation router
→ Provider selection
→ Session management
→ Usage monitoring
→ Fallback
→ Memory
→ Capability/tool execution
→ Response
```

## Supported Use Cases

The Companion Runtime should support domain-agnostic requests such as:

- summarise a meeting
- research a topic
- translate a document
- plan travel
- draft prose
- explain a technical concept
- answer questions using configured capabilities

## Memory and Provider Handoff

The Companion Runtime should preserve continuity across provider switching without repeatedly injecting full Agent Bridge context into every turn.

**Current implementation (issue #69 PR 6):**

- manual provider switching and capacity fallback both clear the target CLI's session (`db.setSession(chatKey, targetCli, null)`) so it starts fresh rather than resuming a possibly stale, long-abandoned native session;
- fallback additionally compacts the outgoing CLI's conversation first (rate-limited by `fallbackCompactCooldown.ts`) and promotes durable memory candidates, so the target CLI's context is a fresh summary rather than raw un-compacted turns; compaction failure never blocks the fallback itself;
- a one-time `handoff_required:<chatKey>:<cliKind>` flag (`src/handoffState.ts`) is set on the target;
- `BridgeEngine` injects context only for a fresh provider invocation. The provider adapter reports the invocation mode, including Codex attachment turns that cannot resume. A pending handoff never overrides a resumed invocation. Handoff markers clear only after provider-session evidence is persisted.
- Minimal pre-seed compaction (`BRIDGE_PRESEED_COMPACT_MODE`, default `off`) runs before an oversized fresh-session handoff when mode is `auto`. It uses `BRIDGE_PRESEED_COMPACT_CHARS` (default `30000`) and never blocks a turn when compaction fails.
- `/context` (`handleCommand`, `src/commands.ts`) is an operator diagnostics command, not a memory browser: it reports pre-seed compact mode/threshold, uncompacted turn/char counts, and a memory *count*. It never lists or renders memory contents. Durable memory is agent-facing only — subprocess CLIs read it via `agent-bridge-context --memory`/`--memory-query`/`--memory-add-json` (`src/contextCommand.ts`). There is no human-facing `/memory` Telegram command, and none is currently planned; memory is long-term recall for agents, not an operator-facing notes feature.

Handoff context should be built from:

- the latest compact summary;
- the latest N recent turns after that summary, bounded by the configured context budget;
- memory-search instructions and guidance;
- persistent memories only when searched or explicitly selected by the agent.

The canonical memory and handoff design is `docs/architecture/memory-and-handoff.md`.

## Explicit Non-Responsibilities

The Companion Runtime must not own or depend on retired Worker concepts:

- repositories
- work items
- worker jobs
- Git branches
- TDD phases
- CI state
- pull requests
- reviewer comments
- merge approval gates

Engineering work starts through the ordinary provider-native agent path. A conversational surface does not import a Worker command or execution subsystem.

Companion/provider development remains supported when used independently. The
ordinary Run path uses its existing execution and repository safety boundaries.
Overlapping file or branch scopes must be coordinated by the operator.

The companion surface also supports `/btw <prompt>` for a fresh, one-off side
question. It uses the currently selected provider without a session identifier,
does not acquire the main conversation lane, runs in tool-free safe mode, and
does not persist conversation or session state. Providers without a verified
tool-free capability reject `/btw` rather than running an unsafe side process.

## Compatibility

Current service names such as interactive Telegram and Discord services may remain unchanged for compatibility. The architectural term is Companion Runtime even where legacy file, service, or environment names still say interactive or bot.
