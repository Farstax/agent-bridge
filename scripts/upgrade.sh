#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
NODE_MIN_MAJOR=24
TARGET_USER="${SUDO_USER:-$(whoami)}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"

# Resolve node: explicit env var → PATH → nvm directory under the target user's home
if [[ -z "${NODE_BIN:-}" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    NODE_BIN="$(find "${TARGET_HOME}/.nvm/versions/node" -maxdepth 3 -name node -type f 2>/dev/null | sort -t/ -k7 -V | tail -1 || true)"
  fi
fi
DEFAULT_AGENT_BRIDGE_SKILLS="red-green-refactor-tdd,requirements-to-acceptance,risk-based-test-strategy,release-readiness-review"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

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

run_as_target_user() {
  if [[ "${USER}" == "${TARGET_USER}" ]]; then
    "$@"
  else
    sudo -u "${TARGET_USER}" env HOME="${TARGET_HOME}" PATH="${PATH}" "$@"
  fi
}

npm_pkg_version() {
  local listing
  listing="$(npm list -g "${1}" --depth=0 2>/dev/null || true)"
  printf '%s\n' "${listing}" \
    | grep "${1}@" \
    | head -1 \
    | sed 's/.*@//' \
    | tr -d '[:space:]' || true
}

cli_command_version() {
  local command="$1" raw
  if ! command -v "${command}" >/dev/null 2>&1; then
    return 0
  fi
  raw="$(run_as_target_user "${command}" --version 2>/dev/null || true)"
  printf '%s\n' "${raw}" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?' | head -1 || true
}

qualification_bridge_commit() {
  local configured="${AGENT_BRIDGE_COMMIT:-${BRIDGE_COMMIT:-${BRIDGE_RELEASE_COMMIT:-}}}"
  if [[ -n "${configured}" ]]; then
    printf '%s\n' "${configured}"
    return
  fi
  if [[ "$(basename "${REPO_DIR}")" =~ ^[0-9a-f]{40}$ ]]; then
    basename "${REPO_DIR}"
    return
  fi
  git -C "${REPO_DIR}" rev-parse HEAD 2>/dev/null || printf '%s\n' unknown
}

qualify_provider_if_needed() {
  local provider="$1" before="$2" after="$3"
  local qualifier="${REPO_DIR}/scripts/provider-qualification.ts"
  local tsx="${REPO_DIR}/node_modules/tsx/dist/cli.mjs"
  if [[ ! -f "${qualifier}" || ! -f "${tsx}" ]]; then
    echo "provider qualification unavailable for ${provider}; runtime payload is incomplete" >&2
    return 2
  fi

  local args=(
    "${NODE_BIN}" "${tsx}" "${qualifier}"
    --provider "${provider}"
    --expected-version "${after}"
    --bridge-commit "$(qualification_bridge_commit)"
    --if-needed
  )
  if [[ -n "${before}" ]]; then
    args+=(--previous-version "${before}")
  fi

  echo "[qualification] ${provider} ${after}"
  local output status
  if output="$(run_as_target_user "${args[@]}")"; then
    status=0
  else
    status=$?
  fi
  if [[ -n "${output}" ]]; then
    printf '%s\n' "${output}"
  fi
  if [[ "${status}" == "0" ]]; then
    return 0
  fi
  if [[ "${status}" == "1"
        && "${output}" == *"\"provider\":\"${provider}\""*
        && "${output}" == *"\"overall\":\"fail\""* ]]; then
    # Exit 1 plus the qualifier's fail JSON means the failed evidence was
    # produced successfully. Keep the installed CLI for diagnosis.
    echo "[qualification] ${provider} ${after}: FAILED — provider marked degraded; no automatic rollback" >&2
    return 0
  fi
  echo "[qualification] ${provider} ${after}: qualification runner failed (exit ${status})" >&2
  return "${status}"
}

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

install_shared_skills() {
  local skills_csv="${AGENT_BRIDGE_SKILLS:-${DEFAULT_AGENT_BRIDGE_SKILLS}}"
  local link_mode="${AGENT_BRIDGE_SKILL_LINK_MODE:-symlink}"
  if [[ -z "${skills_csv}" || "${skills_csv}" == "none" || "${skills_csv}" == "skip" ]]; then
    return
  fi
  if [[ -z "${TARGET_HOME}" ]]; then
    echo "Unable to resolve target home for ${TARGET_USER}" >&2
    exit 1
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

require_node

# ── --update mode: update CLIs + qualify + build + test + safe restart ────────
# Does NOT reinstall systemd units.
if [[ "${1:-}" == "--update" ]]; then
  before_claude=""
  before_codex=""
  if command -v npm >/dev/null 2>&1; then
    before_claude="$(npm_pkg_version @anthropic-ai/claude-code)"
    before_codex="$(npm_pkg_version @openai/codex)"
  fi
  before_agy="$(cli_command_version agy)"

  echo "[update] Updating CLI packages..."
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install --include=dev)
    npm update -g @anthropic-ai/claude-code @openai/codex 2>/dev/null || true
  fi

  echo "[update] Updating agy (antigravity)..."
  bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash'

  if command -v npm >/dev/null 2>&1; then
    after_claude="$(npm_pkg_version @anthropic-ai/claude-code)"
    after_codex="$(npm_pkg_version @openai/codex)"
    [[ -z "${after_claude}" ]] || qualify_provider_if_needed claude "${before_claude}" "${after_claude}"
    [[ -z "${after_codex}" ]] || qualify_provider_if_needed codex "${before_codex}" "${after_codex}"
  fi
  after_agy="$(cli_command_version agy)"
  [[ -z "${after_agy}" ]] || qualify_provider_if_needed agy "${before_agy}" "${after_agy}"

  if (cd "${REPO_DIR}" && npm run | grep -q '^  build$'); then
    echo "[update] Building bridge..."
    (cd "${REPO_DIR}" && npm run build)
  else
    echo "[update] No build script; skipping build"
  fi

  echo "[update] Running tests..."
  if ! (cd "${REPO_DIR}" && npm test); then
    echo "[update] Tests FAILED — aborting service restarts" >&2
    exit 1
  fi

  echo "[update] Restarting active services..."
  UPDATE_SERVICES=(
    agent-bridge-claude
    agent-bridge-codex
    agent-bridge-antigravity
    agent-bridge-interactive
    agent-bridge-discord-interactive
  )
  for svc in "${UPDATE_SERVICES[@]}"; do
    if systemctl is-active --quiet "${svc}" 2>/dev/null; then
      echo "[update]   Restarting ${svc}..."
      sudo systemctl restart "${svc}"
      sleep 2
      if systemctl is-active --quiet "${svc}"; then
        echo "[update]   ${svc}: running"
      else
        echo "[update]   ${svc}: FAILED — check: sudo journalctl -u ${svc} -n 50" >&2
      fi
    else
      echo "[update]   Skipping ${svc} (not active)"
    fi
  done

  echo "[update] Done"
  exit 0
fi

# ── --clis-only mode: upgrade npm CLIs, qualify installed contracts ───────────
if [[ "${1:-}" == "--clis-only" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found" >&2
    exit 1
  fi

  CLIS=("@anthropic-ai/claude-code" "@openai/codex")
  declare -A before_versions
  for pkg in "${CLIS[@]}"; do
    before_versions["${pkg}"]="$(npm_pkg_version "${pkg}")"
  done

  if ! npm install -g "${CLIS[@]}"; then
    echo "npm CLI installation failed" >&2
    exit 1
  fi

  updated_any=0
  for pkg in "${CLIS[@]}"; do
    after="$(npm_pkg_version "${pkg}")"
    before="${before_versions[${pkg}]:-}"
    if [[ -z "${after}" ]]; then
      echo "unable to verify installed version for ${pkg}" >&2
      exit 1
    elif [[ "${after}" != "${before}" ]]; then
      echo "updated: ${pkg} ${before}→${after}"
      updated_any=1
    else
      echo "verified: ${pkg} ${after}"
    fi

    case "${pkg}" in
      @anthropic-ai/claude-code) qualify_provider_if_needed claude "${before}" "${after}" ;;
      @openai/codex) qualify_provider_if_needed codex "${before}" "${after}" ;;
    esac
  done

  if [[ "${updated_any}" == "0" ]]; then
    echo "no-op: CLIs already up to date; qualification cache verified"
  fi
  exit 0
fi

if [[ "${1:-}" != "--skip-cli-install" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm install)
    npm update -g @anthropic-ai/claude-code @openai/codex 2>/dev/null || true
    install_shared_skills
  fi

  if command -v codex >/dev/null 2>&1; then
    run_as_target_user codex --help >/dev/null
  fi

  if ! command -v agy >/dev/null 2>&1; then
    echo "Installing agy..."
    run_as_target_user bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  fi
  if command -v agy >/dev/null 2>&1; then
    run_as_target_user agy --help >/dev/null
  fi

  if command -v claude >/dev/null 2>&1; then
    run_as_target_user claude --version >/dev/null
  fi
elif [[ -n "${AGENT_BRIDGE_SKILLS:-}" && "${AGENT_BRIDGE_SKILLS}" != "none" && "${AGENT_BRIDGE_SKILLS}" != "skip" ]]; then
  install_shared_skills
fi

install_unit agent-bridge-codex
install_unit agent-bridge-antigravity

# Ops housekeeping — not gated by any bot token, always installed.
install_unit agent-bridge-tmp-cleanup
install_timer agent-bridge-tmp-cleanup

ensure_node_default() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    return
  fi
  if grep -q '^NODE_BIN=' "${file}"; then
    sudo sed -i "s|^NODE_BIN=.*|NODE_BIN=${NODE_BIN}|" "${file}"
  else
    printf '\nNODE_BIN=%s\n' "${NODE_BIN}" | sudo tee -a "${file}" > /dev/null
  fi
}

ensure_node_default /etc/default/agent-bridge-codex
ensure_node_default /etc/default/agent-bridge-antigravity

UNITS_TO_ENABLE="agent-bridge-codex agent-bridge-antigravity agent-bridge-tmp-cleanup.timer"

# Install claude unit only if its defaults file is present (created by install.sh)
CLAUDE_DEFAULTS="/etc/default/agent-bridge-claude"
if [[ -f "${CLAUDE_DEFAULTS}" ]]; then
  install_unit agent-bridge-claude
  ensure_node_default "${CLAUDE_DEFAULTS}"
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-claude"
fi

DISCORD_INT_DEFAULTS="/etc/default/agent-bridge-discord-interactive"
if [[ -f "${DISCORD_INT_DEFAULTS}" ]]; then
  install_unit agent-bridge-discord-interactive
  ensure_node_default "${DISCORD_INT_DEFAULTS}"
  UNITS_TO_ENABLE="${UNITS_TO_ENABLE} agent-bridge-discord-interactive"
fi

sudo systemctl daemon-reload
# shellcheck disable=SC2086
sudo systemctl enable --now ${UNITS_TO_ENABLE}

echo "Installed and started: ${UNITS_TO_ENABLE}"
echo "Node: ${NODE_BIN}"
if [[ "${AGENT_BRIDGE_SKILLS:-${DEFAULT_AGENT_BRIDGE_SKILLS}}" != "none" && "${AGENT_BRIDGE_SKILLS:-${DEFAULT_AGENT_BRIDGE_SKILLS}}" != "skip" ]]; then
  echo "Shared skills installed for ${TARGET_USER}: ${AGENT_BRIDGE_SKILLS:-${DEFAULT_AGENT_BRIDGE_SKILLS}}"
fi
