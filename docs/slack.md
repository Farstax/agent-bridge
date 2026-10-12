# Slack integration

Agent Bridge can serve a **customer-owned Slack app** over outbound-only Socket
Mode. Slack is a thin transport into the existing Run, provider, session, queue,
cancellation, fallback, continuation and delivery owners. There is no hosted
service, OAuth broker, phone number or inbound HTTP endpoint, and nothing
outside this repository is required.

## What you get

- Allowlisted direct messages to the bot: each DM channel is one conversation.
- Explicit channel mentions (`@Agent Bridge ...`): each thread root is one
  conversation, and replies stay in that thread.
- Commands as plain text: `!stop`, `!cancel`, `!reset`, `!cli` in a DM, or
  `@Agent Bridge !stop` in a channel. Slack slash commands are not enabled.
- Replies are plain text, chunked at 3,500 characters, posted in order and
  paced at about one message per second per channel.

Not supported in v1: attachments, edits, previews, typing indicators, rich or
interactive messages, passive channel reading, multiple workspaces or Enterprise
Grid, Slack Connect, rotating (`xoxe`) tokens, and Slack Marketplace listing.

## Install

1. Create a Slack app **from manifest** using
   [`examples/slack-app-manifest.yaml`](../examples/slack-app-manifest.yaml).
   It requests the bot scopes `app_mentions:read`, `im:history`, `chat:write`
   and `users:read`, subscribes to `app_mention` and `message.im`, enables
   Socket Mode and the App Home Messages tab, and disables token rotation.
2. Install the app to **one** workspace and copy the bot token (`xoxb-...`).
3. Create an app-level token with the `connections:write` scope (`xapp-...`).
4. Invite the bot to any channel where you want to mention it (private channels
   included). Replies in channels require the bot to be a member.
5. Copy `.env.slack-interactive.example` to `.env.slack-interactive`, write each
   token to its own file readable only by the service account, and fill in:

   | Variable | Meaning |
   | --- | --- |
   | `SLACK_BOT_TOKEN_FILE` or `SLACK_BOT_TOKEN` | Bot token. Exactly one of the pair. |
   | `SLACK_APP_TOKEN_FILE` or `SLACK_APP_TOKEN` | App-level token. Exactly one of the pair. |
   | `SLACK_ALLOWED_USER_IDS` | Required, comma-separated member IDs (`U0123ABCD`). Default deny. |
   | `SLACK_STATUS_FILE` | Optional readiness file (see below). |
   | `DB_PATH` | SQLite database dedicated to this surface. |
   | `INTERACTIVE_CLI_CHAIN`, `BRIDGE_EXECUTION_MODE`, `AGENT_BRIDGE_INSTALLATION_ID` | As for the other surfaces. |

6. Start `src/index-slack-interactive.ts` with your service manager. A systemd
   example is `systemd/agent-bridge-slack-interactive.service`. Any secret
   manager works as long as it mounts the token files.

Token files have trailing newlines trimmed and must be non-empty. Tokens are
never logged. Rotating tokens (`xoxe-...`) are rejected at startup with an
actionable error.

> **Never run the same Slack app in two places.** Slack distributes events for
> one app across every connected socket, including a second Agent Bridge. Agent
> Bridge cannot detect or prevent an external consumer of your app.

## Identity and authorization

At startup the bot token is verified with `auth.test` and `bots.info`, which
establish the workspace (team), bot user and **app ID**. The app-level token is
then bound to that app by the `app_id` Slack states in the hello message of the
actual runtime Socket Mode connection. This is checked again on every reconnect.
A missing or different app ID closes the socket and refuses to serve events.

Only these inputs become work:

- `message` events in a DM with the bot (`channel_type=im`), or `app_mention`
  events that contain the exact `<@bot-user-id>` mention;
- from a user in `SLACK_ALLOWED_USER_IDS`;
- carrying the verified team and app ID.

Bot messages, the bot itself, edits, deletions, other subtypes, group DMs,
unmentioned channel traffic, other workspaces and org-wide installs are ignored.
Allowlisted IDs are checked with `users.info` at startup (they must be active,
non-bot members of the verified workspace). Workspace membership alone never
grants execution rights.

## Delivery and recovery

- Every actionable event is stored as a durable receipt (schema v20,
  `event_receipts`, source `slack`) **before** the envelope is acknowledged.
  If the database write fails the envelope is not acknowledged and Slack may
  redeliver. Duplicates are recognised by `event_id`, not by envelope ID.
- A receipt is dispatched at most once. After a restart, a receipt that was
  stored but never dispatched runs once. A receipt that may already have reached
  a provider is marked `ambiguous` and **is not re-run**; the conversation gets
  one notice asking you to resend if needed.
- Slack retries and network behaviour mean delivery is not exactly-once. A
  confirmed `429` is retried with the advertised `Retry-After` (bounded). Any
  timeout, 5xx or disconnect during a post is treated as ambiguous and is not
  blindly resent; a partially delivered multi-part answer is not resent.
- Replies always use the native Slack channel ID and thread timestamp, including
  queued, fallback, continuation, scheduled and restart notices.

## Readiness file (`SLACK_STATUS_FILE`, schema v1)

Written atomically with mode `0600`, on every socket transition and at least
every 15 seconds while the process is alive:

```json
{
  "schemaVersion": 1,
  "pid": 1234,
  "generation": "random startup UUID",
  "observedAt": "2026-10-12T10:00:00.000Z",
  "state": "connected",
  "appId": "A0123456789",
  "teamId": "T0123456789",
  "botUserId": "U0123456789",
  "lastConnectedAt": "2026-10-12T09:59:30.000Z",
  "errorCode": null
}
```

`state` is one of `connecting`, `connected`, `reconnecting`, `disconnected`,
`reconnect_required`, `failed`. `errorCode` is a bounded identifier such as
`token_revoked`, `token_class_unsupported`, `app_mismatch`, `app_unverified`,
`identity_unavailable`, `allowlist_invalid`, `database_unavailable` or
`socket_error`.

A consumer should treat the process as connected only when `state` is
`connected`, `observedAt` is at most **45 seconds** old, `pid` is the live
process ID, and `generation`, `appId` and `teamId` match what it expects. The
file never contains tokens, socket URLs or message content. A connected record
is an observation; it does not guarantee Slack routes a particular event to
this socket.

## Database and upgrade

The companion uses its own database role (`slack`). The schema version bump to
20 only widens `event_receipts`; the guarded rollout takes the usual backup, and
an older release refuses a version 20 database instead of running against it.
