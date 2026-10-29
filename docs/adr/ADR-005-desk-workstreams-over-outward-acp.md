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
ACP v1 equivalent use the ACP extension-method namespace and are advertised as
`agentCapabilities._meta["agent-bridge"].workstreams = 1`:

| Method | Params | Result |
| --- | --- | --- |
| `_agent-bridge/workstreams/list` | `cwd`, `includeArchived?` | `workstreams[]` with `status` |
| `_agent-bridge/workstreams/update` | `sessionId`, `cwd`, `title?`, `archived?` | `workstream` |
| `_agent-bridge/workstreams/status` | `sessionId`, `cwd` | `workstream`, `status` |
| `_agent-bridge/workstreams/select_provider` | `sessionId`, `cwd`, `provider` | `workstream`, `status` |

Create is standard `session/new` followed by an optional `update` for the
title. Every per-Workstream call must present the session's `cwd`, as
`session/load` already requires. `cwd` is a selector, not an authorisation:
the outward agent serves one workspace owner, so the Platform gateway must
pin `cwd` to the authenticated principal's workspace and never forward a
client-chosen value. Archive is metadata only; an archived Workstream can
still be loaded and prompted, and `update` with `archived: false` restores it.

## Status truth

`status.state` comes only from the latest durable Run of the conversation:
`running`, `failed`, `cancelled`, `attention` (provider recorded a `blocked`
outcome) or `idle`. The outward agent rejects a second concurrent prompt as
busy, so it has no queued state. Bridge never infers attention from message
text or timing. A Run interrupted by a crash reads `running` until restart
reconciliation settles its record.

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

v25 only adds nullable columns. The previous release ignores them and can
still insert sessions.
