# Companion Runtime Architecture

## Status

Canonical architecture documentation.

## Purpose

The Companion Runtime is the domain-agnostic conversational runtime inside Agent Bridge OSS.

It exposes one or more AI runtimes through chat or future TUI surfaces and manages conversation routing, sessions, fallback, retained conversation history, and response delivery.

Agent Bridge is an agent runtime, not a chatbot. An operator message delegates an objective. Provider agents are expected to pursue that objective autonomously within their authority until completion or a genuine operator dependency. Conversation is the control surface, not the execution model. Routine intermediate decisions — a fixable error, a step that finished, a waitable process such as CI or a build — are not bounced back to the operator; the provider is expected to keep driving toward the requested end state using its own tools and judgement. Agent Bridge does not become a task/workflow orchestrator to achieve this: it supplies posture through prompt/authority context (see "Delegation/execution contract" below), not through a Worker, scheduler, or completion-classifier abstraction. The existing safety, cancellation, fallback, provider, and tool authority boundaries described elsewhere in this document remain in force.

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
- retained conversation-turn retrieval and handoff
- capability invocation through the Shared Runtime
- response rendering and delivery

## Flow

```text
Transport
→ Conversation router
→ Provider selection
→ Session management
→ Usage monitoring
→ Fallback
→ Retained turn handoff/retrieval
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

## Conversation History and Provider Handoff

The Companion Runtime preserves continuity across provider switching without repeatedly injecting full Agent Bridge context into every turn.

Current behavior:

- provider-native session IDs are the primary same-provider continuity mechanism;
- manual provider switching and capacity fallback clear the target provider session for the current chat/thread and mark a one-time handoff requirement;
- no generated-summary or project-memory compaction call runs before switching or fallback;
- a fresh provider invocation receives a bounded handoff built from exact retained `conversation_turns`;
- the provider adapter decides whether the invocation is genuinely fresh or resumable; a resumed invocation does not receive a repeated history preamble;
- handoff markers clear only after provider-session evidence is persisted;
- `agent-bridge-context --recent <n>` and `--search <query>` provide scoped exact-turn retrieval for agents when older evidence is needed;
- `/context` is operator diagnostics only: it reports retained-turn/pending-queue status and the supported exact-turn retrieval path;
- historical `conversation_summaries` and `project_memories` rows may remain in databases, but the Companion Runtime does not generate, promote, or inject them into current conversation continuity.

Fresh handoff should orient the provider around the user goal, completed work/evidence, current state, pending next steps, and key constraints. It should also tell the provider how to query older retained turns instead of attempting to fit the full history into every prompt.

The canonical continuity design is `docs/architecture/memory-and-handoff.md`.

## Delegation/execution contract

Fresh-only Soul, managed workspace context, handoff, and retained history remain one-time (see above). Independently of that, ordinary tool-enabled main-lane operator turns on the acting Run path — both fresh and resumed provider sessions — receive a concise, provider-neutral delegation/execution contract (`src/promptWrapping.ts::SESSION_EXECUTION_CONTRACT`, seeded through `src/cli.ts::seedFreshExecutionContract()`). It teaches the provider to treat the operator request as an objective it owns, to prefer acting/inspecting/waiting/retrying/repairing/validating over handing routine next steps back, to treat a fixable in-scope problem as work rather than a blocker, and to hand control back only for a genuine operator dependency (missing information, authority, credentials, a product decision, or an unauthorised irreversible/external-facing action).

Agent-initiated continuations are mechanically bounded (#1084). `src/runContinuation.ts` stores a `depth` on each continuation record, derived from the Run it was admitted from; at most 20 consecutive agent-initiated continuations are accepted. The count survives restarts, provider fallback and recovery because it lives in the durable continuation record, is never reset by an agent-generated wake, and resets only for a Run with no continuation provenance (an owner message, scheduled routine or other independent origin). Capacity-wait retries carry their origin depth unchanged. The 21st request is refused inside the same transaction as the outcome write, the Run is recorded `blocked`, and the engine tells the owner that automatic continuation stopped.

This is prompt/authority-contract posture, not workflow machinery: there is no task state machine, completion classifier, Worker abstraction, scheduler, or automatic Run-loop. Tool-free execution (`/btw`) is explicitly excluded (`toolMode: "none"`), since that path must not act on shared provider state.

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
