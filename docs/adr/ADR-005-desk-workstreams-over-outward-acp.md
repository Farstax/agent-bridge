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
outcome) or `idle`. The outward agent rejects a second concurrent prompt as
busy, so it has no queued state. Bridge never infers attention from message
text or timing. At outward-service startup, existing guarded lock and Run
reconciliation runs only for the outward ACP surface. It proves provider child
absence, releases an expired stale lock, and marks an interrupted durable Run
failed before serving new requests.

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
