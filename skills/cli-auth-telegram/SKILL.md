---
name: cli-auth-telegram
description: "Use when a user chatting over Telegram asks to connect, authenticate, log in, or re-authenticate the Claude, Codex, or Agy (Antigravity) CLI — walks them through the provider's OAuth/device flow with a clickable link and relays any code they paste back into the login process."
---

# CLI Auth via Telegram

Use this skill whenever a user chatting over Telegram asks to connect, sign in, authenticate, or reconnect one of the three CLIs this runtime can drive: Claude, Codex, or Agy (Antigravity). Do not use it for platform-account or billing login questions unrelated to these three CLI credentials.

## Before you start

1. Confirm which CLI the user means. If ambiguous, ask — do not guess.
2. Check whether it is already authenticated by testing for its credential file before doing anything else:
   - Claude: `~/.claude/.credentials.json`
   - Codex: `~/.codex/auth.json`
   - Agy: `~/.gemini/antigravity-cli/antigravity-oauth-token` (fall back to `~/.gemini/oauth_creds.json` only if the primary file is absent)

   If the file exists and is non-empty, tell the user it looks already connected and ask whether they want to re-authenticate anyway before proceeding.
3. Resolve the CLI binary with `command -v <cli>` (`claude`, `codex`, or `agy`) rather than assuming a hardcoded install path — it can vary by environment.

## Running the login

Each CLI behaves differently. Do not send the same instructions for all three.

### Claude

```bash
DISPLAY= <resolved-claude-bin> auth login
```

Prints an OAuth URL, then may prompt for a pasted code. Because this must run in the background while you keep chatting, run it detached with output captured to a log file and stdin wired through a named pipe you control:

```bash
mkdir -p "$RUNTIME_DIR"
mkfifo "$RUNTIME_DIR/claude-auth.pipe" 2>/dev/null || true
( exec 3<>"$RUNTIME_DIR/claude-auth.pipe"; DISPLAY= "$CLAUDE_BIN" auth login <&3 >"$RUNTIME_DIR/claude-auth.log" 2>&1 & )
```

Poll the log briefly for the URL line, then reply to the user with it as a Markdown link plus: "After approving, reply here with the code shown." When their next message arrives, write it to the pipe (`printf '%s\n' "$CODE" > "$RUNTIME_DIR/claude-auth.pipe"`) and confirm the credential file now exists before telling them it worked.

### Codex

```bash
<resolved-codex-bin> login --device-auth
```

Prints a URL and a device code. Codex polls the provider itself — no code needs relaying back through chat. Reply with the link and device code as a Markdown link + code, tell the user no further reply is needed, then poll for the credential file to appear before confirming.

### Agy (Antigravity)

```bash
<resolved-agy-bin>
```

Starts Agy's own provider-owned browser OAuth flow and prints a temporary browser URL; the session stays alive until the callback completes. Reply with the link and poll for the credential file rather than expecting a pasted-back code, unless the CLI's own output explicitly asks for one — if it does, relay it the same way as the Claude flow via a dedicated pipe.

## Safety rules

- Never print the raw device/auth code or URL query secrets into anything other than the single chat reply meant for the user — do not echo them again in later messages, status updates, or error text.
- Set a bounded wait (15 minutes) for the user's code reply or for the credential file to appear. On timeout, kill the background login process, remove its pipe/log files, and tell the user the attempt expired and how to retry.
- Only one login attempt per CLI at a time. If one is already in flight when asked again for the same CLI, tell the user and offer to cancel it rather than starting a second one silently.
- Clean up the log file and named pipe once the flow finishes (success, failure, or timeout) — do not leave credential-adjacent artifacts on disk.
- Confirm success by checking the credential file actually appeared/updated, not merely that the login process exited zero.

## Verification

After the credential file is confirmed present, tell the user the CLI is connected, without repeating any secret material from the exchange.
