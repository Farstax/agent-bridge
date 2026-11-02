# Agent Bridge architecture

Agent Bridge is a provider-native runtime. It keeps recoverable conversation
turns, provider sessions, ordinary Runs, fencing, delivery, and restart
reconciliation. Provider-owned background work stays inside the native CLI turn. Provider agents own engineering workflow through repository
`AGENTS.md`, Skills, tools, and native subagents.

```text
conversation / workstream
        ↓
recoverable turns and history
        ↓
provider-native session
        ↓
ordinary Run
        ↓
provider agent + AGENTS.md + Skills + tools
        ↓
provider-native terminal completion
        ↓
result and external artifacts
```

Unattended work uses the same path:

```text
authenticated durable event receipt
        ↓
ordinary owning Run
        ↓
provider agent + Skills
        ↓
result
```

Agent Bridge has no separate engineering workflow engine, Worker bot, job
dispatcher, role chain, or replacement Task abstraction. Schema version 9
removes the historical Worker tables. Runtime code does not create, claim, or
execute rows in those tables.

The provider adapter owns provider invocation and native terminal-completion protocol details.
`cliSupervisor.ts` remains provider-agnostic. Shared runtime code owns process
supervision, execution locks, Run correlation, cancellation, fallback, and
delivery safety.

## Communication surfaces

Communication adapters translate requests and deliver results. Bridge Core
owns durable admission, the shared `pending_messages` queue, busy-message
policy, provider selection and fallback, Run ownership, execution-capacity
claims, cancellation fencing and recovery. Telegram, Discord and Slack enter
through the shared interactive dispatcher and `BridgeEngine`. Outward ACP uses
the same queue, lane locks, provider router and `BridgeEngine` provider
execution, while its adapter retains ACP sessions, capability negotiation,
streaming, request receipts and wire responses. Those receipts distinguish
accepted queue work from a completed Run; they are not a second queue.

User-facing Stop cancels the active Run and clears accepted pending work. The
ACP `session/cancel` notification only cancels the active request, and
interrupt mode keeps its replacement message. A Stop remains pending until
the Run owner or proven-containment recovery settles the Run. Admission stays
fenced while that Stop is pending. Configured global execution capacity uses
the existing shared coordinator for outward ACP too.

The outward continuation worker resumes only authorised capacity waits.
Ordinary unattended continuation is not advertised to outward ACP because it
has no established ACP delivery and recovery contract. The messaging
continuation owners remain unchanged.

The remaining surface-specific work belongs at the transport boundary:

| Surface | Adapter responsibilities |
|---|---|
| Telegram | Bot API authentication and update polling, chat/topic identity, inline keyboards, Telegram message and media delivery. |
| Discord | Gateway and interaction authentication, channel/thread identity, interaction acknowledgements, Discord components and message formatting. |
| Slack | Socket Mode and Web API authentication, channel/thread identity, event acknowledgements, Block Kit interactions and message formatting. |
| Outward ACP | stdio JSON-RPC framing, session creation/loading, capability negotiation, progress updates, request receipts, resource attachment translation and request-scoped `session/cancel`. |

These adapters call the same command/settings owners, queue, lane fences,
provider router, Run engine, capacity coordinator and recovery records. An ACP
queue receipt describes accepted work; it is not a replacement Run or queue.

ACP v1 is the canonical inward provider-runtime communication contract for
migrated providers. Agent Bridge still owns durable identity, routing, fencing,
and delivery; ACP owns agent communication; the provider agent owns reasoning
and tools. See [ACP.md](../ACP.md). Provider-native runtime modules remain only
for providers whose ACP migration is not complete.
