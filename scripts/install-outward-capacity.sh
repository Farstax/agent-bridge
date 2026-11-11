#!/usr/bin/env bash
set -Eeuo pipefail

# Install the existing outward worker on legacy bot hosts. Fresh interactive
# installs already own this unit through agent-bridge-install.py.
phase="${AGENT_BRIDGE_HOST_COMPONENT_PHASE:-converge}"
[[ "$phase" == prepare || "$phase" == commit || "$phase" == converge || "$phase" == verify ]] ||
  { echo "outward-capacity: unsupported phase" >&2; exit 1; }
if [[ "${1:-}" == --print-required-bytes ]]; then printf '0\n'; exit 0; fi
[[ "$EUID" == 0 ]] || { echo "outward-capacity: root required" >&2; exit 1; }

fail() { echo "outward-capacity: $*" >&2; exit 1; }
healthy() {
  printf 'host_component_health=healthy\n'
}
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$script_dir/../systemd/agent-bridge-outward-capacity.service"
unit_path=/etc/systemd/system/agent-bridge-outward-capacity.service
defaults_path=/etc/default/agent-bridge-outward-capacity
bot_env=/etc/default/agent-bridge-bot
shared_env=/etc/default/agent-bridge-shared
rollout_config=/etc/agent-bridge/rollout.conf
[[ -f "$template" && ! -L "$template" ]] || fail "verified release is missing the worker unit"

secure_file() {
  [[ -f "$1" && ! -L "$1" ]] || fail "missing or unsafe managed file: $1"
  local uid mode
  read -r uid mode < <(stat -c '%u %a' "$1")
  [[ "$uid" == 0 ]] && (( (8#$mode & 022) == 0 )) || fail "unsafe managed file permissions: $1"
}

# No legacy bot: fresh interactive installation already creates and supervises
# this worker, and noninteractive hosts do not require an outward ACP worker.
if [[ ! -e "$bot_env" && ! -L "$bot_env" ]]; then
  if [[ "$phase" == verify ]]; then
    # Fresh interactive installs own this unit independently. Do not report a
    # healthy component if their supervised worker is installed but stopped.
    if [[ -e "$unit_path" || -L "$unit_path" ]]; then
      [[ -f "$unit_path" && ! -L "$unit_path" ]] ||
        fail "fresh outward worker unit is unsafe"
      systemctl is-active --quiet agent-bridge-outward-capacity.service ||
        fail "fresh outward capacity worker is not active"
    fi
    healthy
  else
    printf 'host_component_status=no_op\n'
  fi
  exit 0
fi
secure_file "$bot_env"
secure_file "$rollout_config"
if [[ -e "$shared_env" || -L "$shared_env" ]]; then secure_file "$shared_env"; fi
grep -Fxq 'unit=agent-bridge-bot.service' "$rollout_config" ||
  fail "legacy bot is not in trusted rollout inventory"

runtime_user="$(sed -n 's/^runtime_user=//p' "$rollout_config")"
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]*$ && "$runtime_user" != root ]] ||
  fail "invalid rollout runtime user"
[[ "$(systemctl show agent-bridge-bot.service --property=User --value)" == "$runtime_user" ]] ||
  fail "legacy bot runtime identity mismatch"

# Preserve the systemd EnvironmentFile syntax, without sourcing untrusted
# shell text. Only operational keys are passed; never copy chat/API tokens.
allowed=(
  DB_PATH NODE_BIN INTERACTIVE_CLI_CHAIN INTERACTIVE_DEFAULT_CLI
  AGENT_BRIDGE_INSTALLATION_ID AGENT_BRIDGE_EXECUTION_COORDINATION_DB_PATH
  CODEX_ACP_COMMAND CODEX_ACP_ARGS CLAUDE_ACP_COMMAND CLAUDE_ACP_ARGS
  GROK_ACP_COMMAND GROK_ACP_ARGS AGY_ACP_COMMAND AGY_ACP_ARGS
  CURSOR_ACP_COMMAND CURSOR_ACP_ARGS
)
declare -A settings=()
for env_file in "$shared_env" "$bot_env"; do
  [[ -f "$env_file" ]] || continue
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    for allowed_key in "${allowed[@]}"; do
      if [[ "$key" == "$allowed_key" ]]; then
        [[ "$line" != *$'\r'* ]] || fail "invalid environment value"
        settings["$key"]="$line"
        break
      fi
    done
  done < "$env_file"
done
scalar() {
  local raw="${1#*=}"
  if [[ "$raw" == \"*\" || "$raw" == \'*\' ]]; then raw="${raw:1:${#raw}-2}"; fi
  [[ "$raw" != *[\"\'\\\$]* && "$raw" != *[[:space:]]* ]] ||
    fail "unsafe managed path value"
  printf '%s' "$raw"
}
[[ -n "${settings[DB_PATH]:-}" && -n "${settings[NODE_BIN]:-}" ]] ||
  fail "legacy bot is missing DB_PATH or NODE_BIN"
db_path="$(scalar "${settings[DB_PATH]}")"
node_bin="$(scalar "${settings[NODE_BIN]}")"
[[ "$db_path" == /var/lib/agent-bridge/*.sqlite && -f "$db_path" && ! -L "$db_path" ]] ||
  fail "invalid existing interactive database"
[[ "$(realpath -e "$db_path")" == "$db_path" ]] ||
  fail "noncanonical interactive database"
grep -Fxq "database=$db_path" "$rollout_config" ||
  fail "interactive database not in trusted rollout inventory"
[[ "$node_bin" == /* && -x "$node_bin" && ! -L "$node_bin" ]] ||
  fail "invalid managed Node binary"

current_pointer="$(sed -n 's/^current_pointer=//p' "$rollout_config")"
[[ "$current_pointer" =~ ^/[a-zA-Z0-9/._-]+$ && -L "$current_pointer" ]] ||
  fail "invalid managed release pointer"

# The auxiliary worker is tied to the existing bot's systemd transaction:
# stopping the bot for guarded DB migration stops its worker first. An older
# rollback release without this installer leaves the enabled unit inactive.
unit_contents="# Managed by Agent Bridge outward-capacity host component
$(sed "s/BRIDGE_USER/$runtime_user/g" "$template")"
unit_contents="${unit_contents/After=network-online.target/After=network-online.target agent-bridge-bot.service$'\n'PartOf=agent-bridge-bot.service$'\n'ConditionPathExists=$current_pointer\/scripts\/install-outward-capacity.sh}"
unit_contents="${unit_contents/WantedBy=multi-user.target/WantedBy=agent-bridge-bot.service}"
[[ "$unit_contents" == *"PartOf=agent-bridge-bot.service"* &&
   "$unit_contents" == *"WantedBy=agent-bridge-bot.service"* ]] ||
  fail "unable to bind auxiliary worker lifecycle"

defaults_contents=""
for key in "${allowed[@]}"; do
  [[ -n "${settings[$key]:-}" ]] || continue
  defaults_contents+="${settings[$key]}"$'\n'
done

if [[ -e "$unit_path" || -L "$unit_path" ]]; then
  secure_file "$unit_path"
  grep -Fxq '# Managed by Agent Bridge outward-capacity host component' "$unit_path" ||
    fail "existing capacity unit has another owner"
fi
if [[ -e "$defaults_path" || -L "$defaults_path" ]]; then secure_file "$defaults_path"; fi

if [[ "$phase" == verify ]]; then
  [[ -f "$unit_path" && -f "$defaults_path" ]] ||
    fail "capacity worker has not been installed"
  cmp -s "$unit_path" <(printf '%s\n' "$unit_contents") ||
    fail "worker unit definition has drifted"
  cmp -s "$defaults_path" <(printf '%s' "$defaults_contents") ||
    fail "worker environment has drifted"
  systemctl is-enabled --quiet agent-bridge-outward-capacity.service ||
    fail "capacity unit is not enabled"
  systemctl is-active --quiet agent-bridge-outward-capacity.service ||
    fail "capacity worker is not active"
  healthy
  exit 0
fi
if [[ "$phase" == prepare ]]; then
  printf 'host_component_status=no_op\n'
  exit 0
fi

write_managed() {
  local path="$1" contents="$2" mode="$3" temporary
  if [[ -f "$path" ]] && cmp -s "$path" <(printf '%s' "$contents"); then return 1; fi
  temporary="$(mktemp "${path}.XXXXXX")"
  printf '%s' "$contents" > "$temporary"
  chown root:root "$temporary"
  chmod "$mode" "$temporary"
  mv -f -- "$temporary" "$path"
  return 0
}

changed=0
write_managed "$defaults_path" "$defaults_contents" 0600 && changed=1
write_managed "$unit_path" "$unit_contents"$'\n' 0644 && changed=1
systemctl daemon-reload
systemctl enable --quiet agent-bridge-outward-capacity.service
# Commit happens while the primary service is contained. Only the normal
# guarded restart of the bot may start the new worker via its .wants link.
if [[ "$phase" == converge ]] &&
   systemctl is-active --quiet agent-bridge-bot.service; then
  systemctl start agent-bridge-outward-capacity.service
fi
if (( changed )); then printf 'host_component_status=converged\n'
else printf 'host_component_status=no_op\n'; fi
