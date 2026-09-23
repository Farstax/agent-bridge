#!/usr/bin/env bash
# Export an optional systemd credential as TELEGRAM_BOT_TOKEN_INTERACTIVE.
# Credential creation, encryption, rotation, and deletion stay with the deployment owner.
set +x
set -euo pipefail

credential_name="telegram-bot-token-interactive"
max_bytes=512

fail() {
  printf '%s\n' "$1" >&2
  exit 78
}

load_credential() {
  local directory="${CREDENTIALS_DIRECTORY-}"
  if [[ -z "$directory" ]]; then
    return 0
  fi
  if [[ "$directory" != /* || -L "$directory" || ! -d "$directory" ]]; then
    fail "interactive Telegram credential directory is unavailable"
  fi

  local credential="${directory%/}/${credential_name}"
  if [[ ! -e "$credential" && ! -L "$credential" ]]; then
    return 0
  fi
  if [[ -L "$credential" || ! -f "$credential" ]]; then
    fail "interactive Telegram credential is not a regular file"
  fi
  if [[ ! -r "$credential" ]]; then
    fail "interactive Telegram credential is unreadable"
  fi

  local size token
  size="$(stat -c '%s' -- "$credential" 2>/dev/null)" || fail "interactive Telegram credential is unreadable"
  if [[ ! "$size" =~ ^[0-9]+$ || "$size" -eq 0 || "$size" -gt "$max_bytes" ]]; then
    fail "interactive Telegram credential is malformed"
  fi
  local stripped_size
  stripped_size="$(tr -d '\000' < "$credential" | wc -c | tr -d '[:space:]')" || fail "interactive Telegram credential is unreadable"
  if [[ "$stripped_size" != "$size" ]]; then
    fail "interactive Telegram credential is malformed"
  fi
  token="$(command cat -- "$credential" 2>/dev/null)" || fail "interactive Telegram credential is unreadable"
  if [[ -z "$token" || "$token" =~ [[:space:]] ]]; then
    fail "interactive Telegram credential is malformed"
  fi
  export TELEGRAM_BOT_TOKEN_INTERACTIVE="$token"
}

load_credential
if [[ "$#" -eq 0 ]]; then
  fail "interactive Telegram runtime command is missing"
fi
exec "$@"
