#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
DEFAULTS_DIR="/etc/default"
NODE_MIN_MAJOR=24
TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"

# Resolve node: explicit env var → PATH → nvm directory under the target user's home
if [[ -z "${NODE_BIN:-}" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    NODE_BIN="$(find "${TARGET_HOME}/.nvm/versions/node" -maxdepth 3 -name node -type f 2>/dev/null | sort -t/ -k7 -V | tail -1 || true)"
  fi
fi
DEFAULT_AGENT_BRIDGE_SKILLS="red-green-refactor-tdd,requirements-to-acceptance,risk-based-test-strategy,release-readiness-review,delivery-directives,git-sandbox,cli-auth-telegram"

# Parse flags
NON_INTERACTIVE=0
SKIP_CLI_INSTALL=0
for _arg in "$@"; do
  case "${_arg}" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --skip-cli-install) SKIP_CLI_INSTALL=1 ;;
  esac
done

cat <<'EOF'
agent-bridge install
- shared config reads: /etc/default/agent-bridge-shared  (paths, health monitoring, allowed users)
- codex service reads: /etc/default/agent-bridge-codex   (token, command, DB path)
- antigravity service reads: /etc/default/agent-bridge-antigravity
- claude service reads: /etc/default/agent-bridge-claude  (optional — skipped if no token provided)
- bot-specific file overrides shared file when the same key appears in both
- CODEX_PROJECT_DIR / ANTIGRAVITY_PROJECT_DIR / CLAUDE_PROJECT_DIR override the CLI cwd per bot
- shared local memory is configured automatically for codex, antigravity, and claude
- bundled shared skills are installed into native CLI skill directories by default
EOF

require_node() {
  if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
    echo "Node.js ${NODE_MIN_MAJOR}+ is required." >&2
    exit 1
  fi

  local version major
  version="$("${NODE_BIN}" -p 'process.versions.node')"
  major="${version%%.*}"
  if (( major < NODE_MIN_MAJOR )); then
    echo "Node.js ${NODE_MIN_MAJOR}+ is required. Found ${version}." >&2
    exit 1
  fi
}

ensure_target_user() {
  if [[ -z "${TARGET_USER}" || -z "${TARGET_HOME}" ]]; then
    echo "Unable to resolve the target user and home directory." >&2
    exit 1
  fi
}

env_file_get() {
  local file="$1" key="$2"
  [[ -f "${file}" ]] || return 0
  awk -F= -v key="${key}" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      sub(/^[^=]*=/, "");
      print;
      exit
    }
  ' "${file}"
}

env_file_has_key() {
  local file="$1" key="$2"
  [[ -f "${file}" ]] || return 1
  awk -F= -v key="${key}" '
    $0 !~ /^[[:space:]]*#/ && $1 == key { found = 1; exit }
    END { exit(found ? 0 : 1) }
  ' "${file}"
}

seed_from_env_file() {
  local file="$1"
  local key value
  for key in BRIDGE_ROOT_DIR BRIDGE_PROJECT_DIR BRIDGE_CURRENT_RELEASE_DIR \
              TELEGRAM_ALLOWED_USER_IDS TELEGRAM_ALLOWED_USER_ID \
               TELEGRAM_BOT_TOKEN_CODEX TELEGRAM_BOT_TOKEN_ANTIGRAVITY TELEGRAM_BOT_TOKEN_CLAUDE TELEGRAM_BOT_TOKEN_INTERACTIVE TELEGRAM_BOT_TOKEN_HEALTH \
              CODEX_COMMAND ANTIGRAVITY_COMMAND CLAUDE_COMMAND \
              CODEX_PROJECT_DIR ANTIGRAVITY_PROJECT_DIR CLAUDE_PROJECT_DIR \
              AGENT_BRIDGE_SKILLS AGENT_BRIDGE_SKILL_LINK_MODE \
              BRIDGE_EXECUTION_MODE POLL_INTERVAL_MS FETCH_TIMEOUT_MS \
              BRIDGE_ADVISOR_ENABLED BRIDGE_ADVISOR_MODE BRIDGE_ADVISOR_CHAIN \
              BRIDGE_ADVISOR_MAX_CALLS_PER_TURN BRIDGE_ADVISOR_MAX_CALLS_PER_TASK \
              BRIDGE_ADVISOR_TIMEOUT_MS BRIDGE_ADVISOR_CONTEXT_MAX_CHARS \
              AGENT_BRIDGE_SOUL_PATH AGENT_BRIDGE_SOUL_MODE \
               HEALTH_BOT_MODE HEALTH_MONITOR_ENABLED HEALTH_MONITOR_CADENCE_SECONDS HEALTH_MONITOR_AUTONOMY \
              HEALTH_MONITOR_CHAT_ID HEALTH_SUGGEST_BOT \
              HEALTH_CONTENT_CRAWLER_ENABLED HEALTH_CONTENT_CRAWLER_SCRIPT \
              DISCORD_BOT_TOKEN DISCORD_APPLICATION_ID DISCORD_GUILD_ID DISCORD_ALLOWED_USER_IDS \
              DISCORD_CLI CLI_COMMAND CLI_MODEL_PREFERENCE INTERACTIVE_DEFAULT_CLI INTERACTIVE_CLI_CHAIN; do
    value="$(env_file_get "${file}" "${key}")"
    if [[ "${key}" == BRIDGE_ADVISOR_* ]]; then
      if env_file_has_key "${file}" "${key}" && ! declare -p "${key}" >/dev/null 2>&1; then
        export "${key}=${value}"
      fi
    elif [[ -n "${value}" && -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done
  # Normalise singular alias → plural
  if [[ -z "${TELEGRAM_ALLOWED_USER_IDS:-}" && -n "${TELEGRAM_ALLOWED_USER_ID:-}" ]]; then
    export TELEGRAM_ALLOWED_USER_IDS="${TELEGRAM_ALLOWED_USER_ID}"
  fi
  if [[ -z "${DISCORD_ALLOWED_USER_IDS:-}" && -n "${DISCORD_ALLOWED_USER_ID:-}" ]]; then
    export DISCORD_ALLOWED_USER_IDS="${DISCORD_ALLOWED_USER_ID}"
  fi
}

# write_env_file <example> <target>
# Reads the example line-by-line. For each KEY= line, substitutes the current
# shell value if set; otherwise keeps the example's default verbatim. Advisor
# settings are copied only when explicitly configured, including an empty chain.
write_env_file() {
  local example="$1"
  local target="$2"
  local tmpfile
  tmpfile="$(mktemp)"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" =~ ^([A-Z_][A-Z0-9_]*)= ]]; then
      local key="${BASH_REMATCH[1]}"
      local envval="${!key:-}"
      if [[ "${key}" == BRIDGE_ADVISOR_* ]]; then
        if declare -p "${key}" >/dev/null 2>&1; then
          printf '%s=%s\n' "${key}" "${!key}"
        fi
      elif [[ -n "${envval}" ]]; then
        printf '%s=%s\n' "${key}" "${envval}"
      else
        printf '%s\n' "${line}"
      fi
    else
      printf '%s\n' "${line}"
    fi
  done < "${example}" > "${tmpfile}"
  mv "${tmpfile}" "${target}"
  echo "  wrote ${target}"
}

seed_from_env_file "${REPO_DIR}/.env.shared"
seed_from_env_file "${REPO_DIR}/.env.codex"
seed_from_env_file "${REPO_DIR}/.env.antigravity"
seed_from_env_file "${REPO_DIR}/.env.claude"
seed_from_env_file "${REPO_DIR}/.env.discord-interactive"

prompt() {
  local var="$1" label="$2" default="${3:-}"
  local current="${!var:-}"
  if [[ -n "${current}" ]]; then
    return
  fi
  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    # Use default silently, or leave empty (required vars will be caught by ensure_var)
    export "${var}=${default}"
    return
  fi
  if [[ -n "${default}" ]]; then
    read -r -p "${label} [${default}]: " current || true
    current="${current:-$default}"
  else
    read -r -p "${label}: " current || true
  fi
  export "${var}=${current}"
}

ensure_var() {
  local var="$1" label="$2"
  if [[ -z "${!var:-}" ]]; then
    echo "Error: Missing required value for ${label}." >&2
    if [[ "${NON_INTERACTIVE}" == "1" ]]; then
      echo "  Set it via the environment before calling install.sh --non-interactive." >&2
    fi
    exit 1
  fi
}

prompt BRIDGE_ROOT_DIR    "Bridge root directory"    "${TARGET_HOME}"
prompt BRIDGE_PROJECT_DIR "Bridge project directory" "${REPO_DIR}"
prompt BRIDGE_CURRENT_RELEASE_DIR "Active release pointer" "/opt/agent-bridge/releases/current"
prompt TELEGRAM_ALLOWED_USER_IDS  "Telegram allowed user IDs (comma-separated)"
prompt TELEGRAM_BOT_TOKEN_CODEX       "Codex bot token"
prompt TELEGRAM_BOT_TOKEN_ANTIGRAVITY "Antigravity bot token"
prompt TELEGRAM_BOT_TOKEN_CLAUDE      "Claude bot token (leave blank to skip)"
prompt TELEGRAM_BOT_TOKEN_INTERACTIVE "Interactive bot token (leave blank to skip)"
prompt TELEGRAM_BOT_TOKEN_HEALTH      "Health bot token (leave blank to skip)"
prompt HEALTH_BOT_MODE                 "Health bot mode (standalone|integrated)" "standalone"
prompt DISCORD_BOT_TOKEN              "Discord bot token (leave blank to skip)"
prompt DISCORD_APPLICATION_ID         "Discord application ID (leave blank to skip)"
prompt DISCORD_ALLOWED_USER_IDS       "Discord allowed user IDs (leave blank to skip)"
prompt DISCORD_GUILD_ID               "Discord guild ID (optional, leave blank for global commands)"
prompt CODEX_COMMAND       "Codex command"       "$(command -v codex  2>/dev/null || true)"
prompt ANTIGRAVITY_COMMAND "Antigravity command" "$(command -v agy    2>/dev/null || true)"
prompt CLAUDE_COMMAND      "Claude command"      "$(command -v claude 2>/dev/null || true)"
prompt CODEX_PROJECT_DIR       "Codex working directory (blank = BRIDGE_PROJECT_DIR)"       ""
prompt ANTIGRAVITY_PROJECT_DIR "Antigravity working directory (blank = BRIDGE_PROJECT_DIR)" ""
prompt CLAUDE_PROJECT_DIR      "Claude working directory (blank = BRIDGE_PROJECT_DIR)"      ""
prompt AGENT_BRIDGE_SKILLS "Bundled skills to install (comma-separated, none = skip)" "${DEFAULT_AGENT_BRIDGE_SKILLS}"
prompt AGENT_BRIDGE_SKILL_LINK_MODE "Shared skill link mode (symlink|copy)" "symlink"
prompt BRIDGE_EXECUTION_MODE "Execution mode (safe|trusted)" "trusted"
prompt POLL_INTERVAL_MS      "Poll interval ms"               "1000"
prompt HEALTH_MONITOR_ENABLED         "Enable health monitoring (true|false)"   "false"
prompt HEALTH_MONITOR_CADENCE_SECONDS "Health check cadence (seconds)"           "3600"
prompt HEALTH_MONITOR_AUTONOMY        "Health autonomy (report|suggest|auto)"    "report"
prompt HEALTH_MONITOR_CHAT_ID         "Telegram chat ID for health reports (blank = skip)" ""
prompt HEALTH_SUGGEST_BOT             "Bot to use for suggestions (claude|antigravity|codex)" "claude"

ensure_var BRIDGE_ROOT_DIR           "Bridge root directory"
ensure_var BRIDGE_PROJECT_DIR        "Bridge project directory"
ensure_var BRIDGE_CURRENT_RELEASE_DIR "Active release pointer"
ensure_var TELEGRAM_ALLOWED_USER_IDS "Telegram allowed user IDs"
ensure_var TELEGRAM_BOT_TOKEN_CODEX        "Codex bot token"
ensure_var TELEGRAM_BOT_TOKEN_ANTIGRAVITY  "Antigravity bot token"
ensure_var BRIDGE_EXECUTION_MODE     "Execution mode"

install_shared_skills() {
  local skills_csv="${AGENT_BRIDGE_SKILLS:-${DEFAULT_AGENT_BRIDGE_SKILLS}}"
  local link_mode="${AGENT_BRIDGE_SKILL_LINK_MODE:-symlink}"
  if [[ -z "${skills_csv}" || "${skills_csv}" == "none" || "${skills_csv}" == "skip" ]]; then
    return
  fi
  if [[ "${link_mode}" != "symlink" && "${link_mode}" != "copy" ]]; then
    echo "Invalid AGENT_BRIDGE_SKILL_LINK_MODE: ${link_mode}" >&2
    exit 1
  fi

  IFS=',' read -r -a skills <<< "${skills_csv}"
  for skill in "${skills[@]}"; do
    skill="$(echo "${skill}" | xargs)"
    [[ -n "${skill}" ]] || continue
    echo "Installing shared skill: ${skill} (${link_mode})"
    if [[ "${USER}" == "${TARGET_USER}" ]]; then
      (cd "${REPO_DIR}" && SHARED_MEMORY_HOME="${TARGET_HOME}" "${NODE_BIN}" ./node_modules/tsx/dist/cli.mjs scripts/skill-manager.ts install "${skill}" --force --link-mode "${link_mode}")
    else
      sudo -u "${TARGET_USER}" env HOME="${TARGET_HOME}" SHARED_MEMORY_HOME="${TARGET_HOME}" NODE_BIN="${NODE_BIN}" \
        bash -c 'cd "$1" && "$NODE_BIN" ./node_modules/tsx/dist/cli.mjs scripts/skill-manager.ts install "$2" --force --link-mode "$3"' bash "${REPO_DIR}" "${skill}" "${link_mode}"
    fi
  done
}

mkdir -p "${DEFAULTS_DIR}"

install_unit() {
  local name="$1"
  sed -e "s/BRIDGE_USER/${TARGET_USER}/g" \
      "${REPO_DIR}/systemd/${name}.service" \
    | sudo tee "${SYSTEMD_DIR}/${name}.service" > /dev/null
  sudo chmod 0644 "${SYSTEMD_DIR}/${name}.service"
}

install_timer() {
  local name="$1"
  sed -e "s/BRIDGE_USER/${TARGET_USER}/g" \
      "${REPO_DIR}/systemd/${name}.timer" \
    | sudo tee "${SYSTEMD_DIR}/${name}.timer" > /dev/null
  sudo chmod 0644 "${SYSTEMD_DIR}/${name}.timer"
}

# Returns the path to a binary from PATH only (CLIs are external global installs)
resolve_binary() {
  local binary="$1"
  if command -v "${binary}" >/dev/null 2>&1; then
    command -v "${binary}"
    return
  fi
  echo ""
}

# Install or upgrade codex and claude via npm; exit with install hint if npm unavailable.
install_or_upgrade_npm_clis() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found — install Node 24+ first" >&2
    exit 1
  fi
  npm install -g @anthropic-ai/claude-code @openai/codex
  export PATH="${TARGET_HOME}/.local/bin:${PATH}"
}

# Install or upgrade agy via the Google Antigravity installer (idempotent).
ensure_agy_cli() {
  echo "Installing/updating agy via Google Antigravity installer..."
  curl -fsSL https://antigravity.google/cli/install.sh | bash
  export PATH="${TARGET_HOME}/.local/bin:${PATH}"
}

require_node
ensure_target_user

if [[ "${SKIP_CLI_INSTALL}" != "1" ]]; then
  (cd "${REPO_DIR}" && npm install)
  install_or_upgrade_npm_clis
  ensure_agy_cli
  CODEX_COMMAND="${CODEX_COMMAND:-$(resolve_binary codex)}"
  ANTIGRAVITY_COMMAND="${ANTIGRAVITY_COMMAND:-$(resolve_binary agy)}"
  CLAUDE_COMMAND="${CLAUDE_COMMAND:-$(resolve_binary claude)}"
  install_shared_skills
elif [[ -n "${AGENT_BRIDGE_SKILLS:-}" ]]; then
  install_shared_skills
fi

ensure_var CODEX_COMMAND       "Codex command"
ensure_var ANTIGRAVITY_COMMAND "Antigravity command"
if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  ensure_var CLAUDE_COMMAND "Claude command"
fi

# Write local .env.* files from examples (machine-specific values substituted in)
echo "Writing local env files..."
write_env_file "${REPO_DIR}/.env.shared.example"      "${REPO_DIR}/.env.shared"
write_env_file "${REPO_DIR}/.env.codex.example"       "${REPO_DIR}/.env.codex"
write_env_file "${REPO_DIR}/.env.antigravity.example" "${REPO_DIR}/.env.antigravity"
if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  write_env_file "${REPO_DIR}/.env.claude.example"    "${REPO_DIR}/.env.claude"
fi
if [[ -n "${DISCORD_BOT_TOKEN:-}" ]]; then
  write_env_file "${REPO_DIR}/.env.discord-interactive.example" "${REPO_DIR}/.env.discord-interactive"
fi

write_optional_env() {
  local key="$1"
  if declare -p "${key}" >/dev/null 2>&1; then
    printf '%s=%s\n' "${key}" "${!key}"
  fi
}

# Write shared defaults loaded by all services
_write_shared_defaults() {
  local dest="${DEFAULTS_DIR}/agent-bridge-shared"
  {
    echo "BRIDGE_ROOT_DIR=${BRIDGE_ROOT_DIR}"
    echo "BRIDGE_PROJECT_DIR=${BRIDGE_PROJECT_DIR}"
    echo "NODE_BIN=${NODE_BIN}"
    echo "TELEGRAM_ALLOWED_USER_IDS=${TELEGRAM_ALLOWED_USER_IDS}"
    echo "BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE}"
    echo "BRIDGE_ASYNC_ENABLED=true"
    echo "POLL_INTERVAL_MS=${POLL_INTERVAL_MS:-1000}"
    echo "FETCH_TIMEOUT_MS=${FETCH_TIMEOUT_MS:-45000}"
    for key in BRIDGE_ADVISOR_ENABLED BRIDGE_ADVISOR_MODE BRIDGE_ADVISOR_CHAIN \
               BRIDGE_ADVISOR_MAX_CALLS_PER_TURN BRIDGE_ADVISOR_MAX_CALLS_PER_TASK \
               BRIDGE_ADVISOR_TIMEOUT_MS BRIDGE_ADVISOR_CONTEXT_MAX_CHARS; do
      write_optional_env "${key}"
    done
    [[ -n "${AGENT_BRIDGE_SOUL_PATH:-}" ]]  && echo "AGENT_BRIDGE_SOUL_PATH=${AGENT_BRIDGE_SOUL_PATH}"
    [[ -n "${AGENT_BRIDGE_SOUL_MODE:-}" ]]  && echo "AGENT_BRIDGE_SOUL_MODE=${AGENT_BRIDGE_SOUL_MODE}"
    echo "HEALTH_MONITOR_ENABLED=${HEALTH_MONITOR_ENABLED:-false}"
    echo "HEALTH_BOT_MODE=${HEALTH_BOT_MODE:-standalone}"
    echo "HEALTH_MONITOR_CADENCE_SECONDS=${HEALTH_MONITOR_CADENCE_SECONDS:-3600}"
    echo "HEALTH_MONITOR_AUTONOMY=${HEALTH_MONITOR_AUTONOMY:-report}"
    [[ -n "${HEALTH_MONITOR_CHAT_ID:-}" ]]          && echo "HEALTH_MONITOR_CHAT_ID=${HEALTH_MONITOR_CHAT_ID}"
    [[ -n "${HEALTH_SUGGEST_BOT:-}" ]]               && echo "HEALTH_SUGGEST_BOT=${HEALTH_SUGGEST_BOT}"
    echo "HEALTH_CONTENT_CRAWLER_ENABLED=${HEALTH_CONTENT_CRAWLER_ENABLED:-0}"
    [[ -n "${HEALTH_CONTENT_CRAWLER_SCRIPT:-}" ]]   && echo "HEALTH_CONTENT_CRAWLER_SCRIPT=${HEALTH_CONTENT_CRAWLER_SCRIPT}"
    [[ -n "${TELEGRAM_BOT_TOKEN_HEALTH:-}" ]]        && echo "TELEGRAM_BOT_TOKEN_HEALTH=${TELEGRAM_BOT_TOKEN_HEALTH}"
    true
  } | sudo tee "${dest}" > /dev/null
  echo "  wrote ${dest}"
}

# Write bot-specific defaults (token, command, DB path — shared vars come from agent-bridge-shared)
_write_systemd_defaults() {
  local bot="$1"
  local token_var="$2"
  local cmd_var="$3"
  local proj_var="$4"
  local dest="${DEFAULTS_DIR}/agent-bridge-${bot}"

  {
    echo "BRIDGE_ENV_FILE=${dest}"
    echo "${token_var}=${!token_var:-}"
    echo "${cmd_var}=${!cmd_var:-}"
    [[ -n "${!proj_var:-}" ]] && echo "${proj_var}=${!proj_var}"
    true
  } | sudo tee "${dest}" > /dev/null
  echo "  wrote ${dest}"
}

_write_release_defaults() {
  local dest="${DEFAULTS_DIR}/agent-bridge-release"
  {
    echo "BRIDGE_CURRENT_RELEASE_DIR=${BRIDGE_CURRENT_RELEASE_DIR}"
  } | sudo tee "${dest}" > /dev/null
  sudo chmod 0644 "${dest}"
  echo "  wrote ${dest}"
}

_write_release_defaults
_write_shared_defaults
_write_systemd_defaults codex       TELEGRAM_BOT_TOKEN_CODEX       CODEX_COMMAND       CODEX_PROJECT_DIR
_write_systemd_defaults antigravity TELEGRAM_BOT_TOKEN_ANTIGRAVITY ANTIGRAVITY_COMMAND ANTIGRAVITY_PROJECT_DIR
if [[ -n "${TELEGRAM_BOT_TOKEN_HEALTH:-}" || "${HEALTH_BOT_MODE:-standalone}" == "integrated" ]]; then
  if [[ "${HEALTH_BOT_MODE:-standalone}" == "integrated" ]]; then
    ensure_var TELEGRAM_BOT_TOKEN_INTERACTIVE "Interactive bot token required for integrated health"
    _write_systemd_defaults health TELEGRAM_BOT_TOKEN_INTERACTIVE HEALTH_CLI_COMMAND HEALTH_CLI_BOT
  else
    _write_systemd_defaults health TELEGRAM_BOT_TOKEN_HEALTH HEALTH_CLI_COMMAND HEALTH_CLI_BOT
  fi
fi

_write_interactive_defaults() {
  local dest="${DEFAULTS_DIR}/agent-bridge-interactive"
  {
    echo "BRIDGE_ENV_FILE=${dest}"
    echo "TELEGRAM_BOT_TOKEN_INTERACTIVE=${TELEGRAM_BOT_TOKEN_INTERACTIVE:-}"
    echo "INTERACTIVE_DEFAULT_CLI=${INTERACTIVE_DEFAULT_CLI:-codex}"
    echo "INTERACTIVE_CLI_CHAIN=${INTERACTIVE_CLI_CHAIN:-codex,claude,antigravity}"
    echo "CODEX_COMMAND=${CODEX_COMMAND:-codex}"
    echo "CLAUDE_COMMAND=${CLAUDE_COMMAND:-claude}"
    echo "ANTIGRAVITY_COMMAND=${ANTIGRAVITY_COMMAND:-agy}"
    echo "DB_PATH=${DB_PATH:-${BRIDGE_ROOT_DIR}/runtime/agent-bridge/interactive/bridge.sqlite}"
    true
  } | sudo tee "${dest}" > /dev/null
  echo "  wrote ${dest}"
}

_write_discord_defaults() {
  local bot="$1"
  local dest="${DEFAULTS_DIR}/agent-bridge-${bot}"

  {
    echo "BRIDGE_ENV_FILE=${dest}"
    echo "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}"
    echo "DISCORD_APPLICATION_ID=${DISCORD_APPLICATION_ID:-}"
    [[ -n "${DISCORD_GUILD_ID:-}" ]] && echo "DISCORD_GUILD_ID=${DISCORD_GUILD_ID}"
    [[ -n "${DISCORD_ALLOWED_USER_IDS:-}" ]] && echo "DISCORD_ALLOWED_USER_IDS=${DISCORD_ALLOWED_USER_IDS}"
    if [[ "${bot}" == "discord" ]]; then
      echo "DISCORD_CLI=${DISCORD_CLI:-claude}"
      echo "CLI_COMMAND=${CLI_COMMAND:-claude}"
      [[ -n "${CLI_MODEL_PREFERENCE:-}" ]] && echo "CLI_MODEL_PREFERENCE=${CLI_MODEL_PREFERENCE}"
    else
      echo "INTERACTIVE_DEFAULT_CLI=${INTERACTIVE_DEFAULT_CLI:-codex}"
      echo "INTERACTIVE_CLI_CHAIN=${INTERACTIVE_CLI_CHAIN:-codex,claude,antigravity}"
      echo "CODEX_COMMAND=${CODEX_COMMAND:-codex}"
      echo "CLAUDE_COMMAND=${CLAUDE_COMMAND:-claude}"
      echo "ANTIGRAVITY_COMMAND=${ANTIGRAVITY_COMMAND:-agy}"
      echo "BRIDGE_EXECUTION_MODE=${BRIDGE_EXECUTION_MODE:-trusted}"
    fi
    true
  } | sudo tee "${dest}" > /dev/null
  echo "  wrote ${dest}"
}

install_unit agent-bridge-codex
install_unit agent-bridge-antigravity
if [[ -n "${TELEGRAM_BOT_TOKEN_INTERACTIVE:-}" ]]; then
  _write_interactive_defaults
  install_unit agent-bridge-interactive
fi
if [[ -n "${TELEGRAM_BOT_TOKEN_HEALTH:-}" || "${HEALTH_BOT_MODE:-standalone}" == "integrated" ]]; then
  install_unit agent-bridge-health
fi

# Ops housekeeping — not gated by any bot token, always installed.
install_unit agent-bridge-tmp-cleanup
install_timer agent-bridge-tmp-cleanup

UNITS_TO_ENABLE="agent-bridge-codex agent-bridge-antigravity agent-bridge-tmp-cleanup.timer"
if [[ -n "${TELEGRAM_BOT_TOKEN_INTERACTIVE:-}" ]]; then
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-interactive"
fi
if [[ -n "${TELEGRAM_BOT_TOKEN_HEALTH:-}" || "${HEALTH_BOT_MODE:-standalone}" == "integrated" ]]; then
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-health"
fi

if [[ -n "${TELEGRAM_BOT_TOKEN_CLAUDE:-}" ]]; then
  _write_systemd_defaults claude TELEGRAM_BOT_TOKEN_CLAUDE CLAUDE_COMMAND CLAUDE_PROJECT_DIR
  install_unit agent-bridge-claude
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-claude"
fi

if [[ -n "${DISCORD_BOT_TOKEN:-}" ]]; then
  _write_discord_defaults discord-interactive
  install_unit agent-bridge-discord-interactive
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-discord-interactive"
fi

sudo systemctl daemon-reload
# Enable only. Pointer activation is a separate guarded operation and service
# startup must not happen until the canonical pointer and its manifest have
# been validated by the rollout helper.
# shellcheck disable=SC2086
sudo systemctl enable ${UNITS_TO_ENABLE}

echo "Installed and enabled, not started: ${UNITS_TO_ENABLE}"
echo "Defaults written to ${DEFAULTS_DIR}/"
if [[ -n "${AGENT_BRIDGE_SKILLS:-}" && "${AGENT_BRIDGE_SKILLS}" != "none" && "${AGENT_BRIDGE_SKILLS}" != "skip" ]]; then
  echo "Shared skills installed: ${AGENT_BRIDGE_SKILLS}"
fi
