---
name: cli-auth-telegram
description: "Use when a user chatting over Telegram asks to connect, authenticate, log in, or re-authenticate the Claude, Codex, Agy (Antigravity), or Grok Build CLI — walks them through the provider's OAuth/device flow with a clickable link and relays any code they paste back into the login process."
---

# CLI Auth via Telegram

Use this skill whenever a user chatting over Telegram asks to connect, sign in, authenticate, or reconnect one of the CLI authentication flows covered here: Claude, Codex, Agy (Antigravity), or Grok Build. Do not use it for platform-account or billing login questions unrelated to these CLI credentials.

## Before you start

1. Confirm which CLI the user means. If ambiguous, ask — do not guess.
2. Check whether it is already authenticated by testing for its credential file before doing anything else:
   - Claude: `~/.claude/.credentials.json`
   - Codex: `~/.codex/auth.json`
   - Agy: `~/.gemini/antigravity-cli/antigravity-oauth-token` (fall back to `~/.gemini/oauth_creds.json` only if the primary file is absent)
   - Grok Build: `~/.grok/auth.json` (also accept `~/.config/grok/auth.json`, which Agent Bridge retains as a compatibility path)

   If the file exists and is non-empty, tell the user it looks already connected and ask whether they want to re-authenticate anyway before proceeding.

   For Grok, if neither credential file exists but `XAI_API_KEY` is non-empty, tell the user Grok is already authenticated through an operator-provided API key without printing its value. If they asked to connect their own Grok account, ask whether they want to continue with device authentication.
3. Resolve the CLI binary with `command -v <cli>` (`claude`, `codex`, `agy`, or `grok`) rather than assuming a hardcoded install path — it can vary by environment.

## Running the login

Each CLI behaves differently. Do not send the same instructions for all four.

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

### Grok Build

```bash
<resolved-grok-bin> login --device-auth
```

`--device-code` is an alias. The device flow prints a verification URL and short user code, then Grok polls xAI for completion. The command must remain alive while the user approves it, so run it in the background with output captured under the runtime directory:

```bash
mkdir -p "$RUNTIME_DIR"
( "$GROK_BIN" login --device-auth >"$RUNTIME_DIR/grok-auth.log" 2>&1 & echo $! >"$RUNTIME_DIR/grok-auth.pid" )
```

Poll the log briefly for the verification URL and code, reply with them as a Markdown link + code, and tell the user no further reply is needed. Then poll for either supported Grok credential path before confirming. On timeout, kill the PID recorded in `grok-auth.pid` if it is still running, then remove the Grok auth log/PID files.

Do not use plain `grok login` in a headless/Telegram context because its default flow tries to launch a local browser. `XAI_API_KEY` is a supported Grok automation credential and Agent Bridge can route with it, but do not substitute it when the user asked to connect their own Grok account; use an API key only when the operator explicitly requested or approved that authentication method.

## Safety rules

- Never print the raw device/auth code or URL query secrets into anything other than the single chat reply meant for the user — do not echo them again in later messages, status updates, or error text.
- Set a bounded wait (15 minutes) for the user's code reply or for the credential file to appear. On timeout, kill the background login process, remove its pipe/log/PID files, and tell the user the attempt expired and how to retry.
- Only one login attempt per CLI at a time. If one is already in flight when asked again for the same CLI, tell the user and offer to cancel it rather than starting a second one silently.
- Clean up the log, pipe, and PID files once the flow finishes (success, failure, or timeout) — do not leave credential-adjacent artifacts on disk.
- Confirm success by checking the credential file actually appeared/updated, not merely that the login process exited zero.

## Verification

After the credential file is confirmed present, tell the user the CLI is connected, without repeating any secret material from the exchange.
