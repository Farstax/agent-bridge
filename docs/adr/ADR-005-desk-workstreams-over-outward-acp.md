# ADR-005: Farstax Desk Workstreams over outward ACP v1

Status: accepted (#1101). Consumer: Platform #1355 (Farstax Desk).

## Decision

A **Workstream** is one outward ACP session (`outward_acp_sessions`) bound to
one stable Bridge conversation ID (`acp:<uuid>`). It is not a provider, bot,
repository or provider session. No new identity or transcript table exists:
title and archive state are two nullable columns on the existing session row
(schema v25), and history stays in the existing conversation turns that
`session/load` already replays.

Desk uses the existing **workspace-local stdio** outward ACP agent
(`npm run acp:serve`). Standard ACP v1 methods are unchanged. Controls with no
ACP v1 equivalent use the ACP extension-method namespace and are advertised in
`agentCapabilities._meta["agent-bridge"]` when wired:

| Method | Params | Result |
| --- | --- | --- |
| `_agent-bridge/workstreams/list` | `cwd`, `includeArchived?` | `workstreams[]` with `status` |
| `_agent-bridge/workstreams/update` | `sessionId`, `cwd`, `title?`, `archived?` | `workstream` |
| `_agent-bridge/workstreams/status` | `sessionId`, `cwd` | `workstream`, `status` |
| `_agent-bridge/workstreams/select_provider` | `sessionId`, `cwd`, `provider` | `workstream`, `status` |
| `_agent-bridge/commands/list` | `sessionId`, `cwd` | provider-aware `commands[]` with route, availability and reason |
| `_agent-bridge/commands/run` | `sessionId`, `cwd`, `command`, optional `argument`, `select`, `confirm` | command result and selectable options |

Create is standard `session/new` followed by an optional `update` for the
title. Every per-Workstream call must present the session's `cwd`, as
`session/load` already requires. The stdio process pins an authorised workspace
root from trusted `BRIDGE_ACP_WORKSPACE_ROOT`, falling back to `BRIDGE_PROJECT_DIR`
(or the launch directory), resolves the
requested `cwd`, and rejects paths outside that root before creating or using
a Workstream. Platform must launch the process for the principal's workspace
and must never forward a client-chosen root. Archive is metadata only; an archived Workstream can
still be loaded and prompted, and `update` with `archived: false` restores it.

Command entries reuse `src/commands.ts` and existing setting, provider switch,
cancellation, reset and side-question owners. Literal `session/prompt` text is
forwarded to the provider; Bridge commands require the explicit command extension. `/queue_mode` is
listed as unavailable because outward ACP rejects concurrent prompts instead
of queueing them. `/sensors` and `/autonomy` fail closed because this local ACP
surface has no authorisation context for those controls. `/stop` uses the
active outward Run cancellation path; `/reset` requires explicit confirmation
and runs under the conversation lane fence.

Embedded ACP `image` and `resource` payloads are staged for one Run in a
private, randomly named directory under the validated Workstream `cwd`. Supported files
are text/code, JSON, CSV, logs, Markdown, PNG, JPEG and PDF. Input allows up to
eight files, 8 MiB per file and 16 MiB total. Names are reduced to bounded safe
filenames, and content stays inside the authorized workspace. Unsupported
blocks and file types fail before provider execution. Staged files are removed
after success, failure or cancellation. The existing daily maintenance owner
removes only owner-marked staging directories more than 24 hours old when
the staging process is known to be absent. Legacy directories without a
process marker are retained because their ownership cannot be proven. A `resource_link` alone is metadata, not uploaded bytes,
and is not treated as an attachment.

## Status truth

`status.state` comes only from the latest durable Run of the conversation:
`running`, `failed`, `cancelled`, `attention` (provider recorded a `blocked`
outcome) or `idle`. `status.queued` is the count of durably accepted messages
that have not started (see Busy messages). A non-opted-in client's second
concurrent prompt is still rejected as busy. Bridge never infers attention from message
text or timing. At outward-service startup, existing guarded lock and Run
reconciliation runs only for the outward ACP surface. It proves provider child
absence, releases an expired stale lock, and marks an interrupted durable Run
failed before serving new requests.

## Deferred capacity (opt-in, #1114)

Standard ACP v1 clients retain immediate request/response semantics. Desk may
opt in only when `agentCapabilities._meta["agent-bridge"].deferredCapacity`
is advertised. It sends `session/prompt._meta["agent-bridge/defer-capacity"] = 1`.
After durable admission of the failed Run, original input and retained
attachments, Agent Bridge may return `stopReason: "end_turn"` with metadata
`{"agent-bridge":{"outcome":"deferred","runId":"..."} }`. This ends the ACP
exchange, not the task. Desk must verify the same Run ID and `waiting`
Workstream status, then observe eventual completion through durable history.

The existing continuation runner, supervised independently of Desk, owns
bounded wake, retry, restart and expiry. A successor Run is linked before any
execution; retained input is released only after durable completion is proven.
Waiting blocks concurrent mutation; `_agent-bridge/workstreams/cancel_deferred`
cancels pending waits under a fence, not active provider processes.
Ordinary prompts keep ephemeral staging; only opted-in waits retain input.
Busy-message queueing (above) is separate: capacity deferral keeps its own
continuation record. Installation is owned by workspace release convergence, not Desk launch.

## Busy messages (opt-in, #1130)

Communication adapters translate and deliver. Bridge Core admits, executes,
coordinates and recovers. Outward ACP therefore uses the same durable
admission, queue, lane fencing, provider fallback and recovery as Telegram,
Discord and Slack; it has no queue of its own.

**Contract.** Standard ACP v1 clients keep fail-fast busy (`-32002`). A client
may submit during an active Run only when
`agentCapabilities._meta["agent-bridge"].busyMessages` is advertised and the
prompt carries `_meta["agent-bridge/busy-messages"] = 1`. Optional
`_meta["agent-bridge/request-id"]` (`[A-Za-z0-9._:-]{1,128}`) makes a
submission idempotent.

An accepted response is **not** a completed provider response. It returns
`stopReason: "end_turn"` with
`_meta["agent-bridge"] = { outcome, queueId, mode, position, requestId }` where
`outcome` is:

- `queued`: durably stored in the shared `pending_messages` queue (bounded depth
  5); it will run in order as its own Run. `position` is one-based.
- `steered`: injected into the live provider turn (augment only).
- `running` / `settled`: a repeated `request-id` answered from durable state;
  `settled` carries the terminal `status` and `runId`. A request is never
  admitted twice.

Progress is read from `status.queued` and the existing Workstream status and
history; Desk must not guess or silently retry an uncertain admission, and
should resend with the same `request-id` instead.

**Modes** are the shared per-lane busy-message setting (`/queue_mode`, default
`queue` for outward). `queue` stores the message. `interrupt` stores it, then
stops the active Run, wherever its owner process is, and the stored message
runs next. `augment` steers a live turn only when the owner is this process and
the provider qualified for steering; otherwise it falls back to `queue`.

**Ownership and recovery.** Any ACP process, or the supervised workspace
worker, may run queued work: the lane lock and a per-row claim give exactly one
owner. A Run is linked to its queue row in the transaction that creates the
Run. A restart that finds a row whose Run may already have started settles it
as failed (`interrupted`) and never replays it. A verified capacity rejection
requeues the row (bounded retries); other terminal Runs settle it. Queued
progress needs a live ACP process or the worker; accepted work is never lost,
but it does not run until one exists.

**Stop** from another process records a durable request for the exact Run id,
which the owning process observes and contains with its normal fenced
cancellation. Locks are never released by the requester; a dead owner is
handled by the existing proven-containment recovery.

Stop distinguishes **requested** from **confirmed**. `/stop` returns
`stop: "confirmed"` only when the durable Run record shows nothing running (the
Run was cancelled, or had already ended). If the owner has not reported the Run
ended within the bounded wait (hung provider, unresponsive or vanished owner),
it returns `stop: "pending"`: the Run may still be executing, no lock was
released and nothing was replayed. A client must show pending as unconfirmed and
re-check status; `/reset` refuses to proceed while Stop is unconfirmed. The
`session/cancel` notification has no reply, so a client that needs the result
uses `/stop`.

**Attachments** accepted into the queue are copied into the existing private,
bounded, owner-marked retention before acceptance is acknowledged, survive the
submitting connection, and are released only after the row settles. A queued
snapshot has no age expiry while a queue row references it. The existing
maintenance job reclaims one only when it is also older than an hour, owner-verified
and referenced by no queue row (a crash between retention and the row insert);
otherwise it is kept.

**Stop and cancellation are different operations.** A user-facing `stop`
atomically fences new admission, removes queued and claimed rows for the
Workstream, and records cancelled receipts for idempotent retries. It then
cancels the active Run through its owner. Unstarted attachment snapshots can
be released after row removal; a claimed snapshot stays until the owner has
settled its Run. If the owner does not confirm within the wait bound, Stop
remains pending and admission stays fenced until owner or proven-containment
recovery settles the Run and the existing outward worker clears the fence.
Repeated Stop is safe. Standard ACP `session/cancel` cancels only its active
request and leaves previously accepted queue work intact. Interrupt mode also
cancels only the active Run and preserves the replacement message.

Outward provider execution participates in the configured shared execution
capacity coordinator through `BridgeEngine`. The supervised outward worker
continues to own capacity-wait recovery. Ordinary unattended continuations
are not exposed to outward ACP: the existing ACP worker has no delivery and
recovery contract for ordinary continuations.

## Provider selection

`select_provider` accepts only a configured chain member that is currently
installed and authenticated. It takes the conversation lane for the write, so
a Workstream with an active Run fails with the busy error (`-32002`) and the
in-flight Run is never retargeted. The selection is stored with the existing
interactive CLI preference and manual-switch handoff (same as Telegram
`/cli`), so it survives restart, keeps the conversation ID and starts the new
provider with a fresh provider session. Fallback still advances along the
configured chain from the selected head. `status.selectedProvider` is the
durable choice; `status.nextProvider` is the provider the next Run starts
with, which differs after an in-process fallback.

## Trust boundary

The stdio process runs as the workspace owner UID and holds the only DB
handle. OSS opens no listener. Platform owns login, tenant identity and any
browser-facing gateway; it must reach this process only through a broker that
runs as the workspace UID (see #1056 for the cross-UID invariant). Provider
credentials never leave the workspace.

## Rollback

v25 adds nullable columns without changing existing session data. Production
services require an exact schema-version match, so the previous release must
not open a v25 database directly. The guarded rollout's failure rollback
restores the verified pre-migration database backups before it restarts the
previous release. Do not downgrade `user_version` or switch the release
pointer alone.
