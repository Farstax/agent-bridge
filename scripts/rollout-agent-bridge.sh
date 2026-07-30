#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Guarded production rollout helper. Install root-owned at:
#   /usr/local/sbin/rollout-agent-bridge
# with its root-owned inventory at:
#   /etc/agent-bridge/rollout.conf

readonly -a ALLOWED_UNITS=(
  agent-bridge-antigravity.service
  agent-bridge-claude.service
  agent-bridge-codex.service
  agent-bridge-discord-interactive.service
  agent-bridge-health.service
  agent-bridge-interactive.service
  agent-bridge-worker-bot.service
)
readonly CLEANUP_SERVICE_UNIT="agent-bridge-tmp-cleanup.service"
readonly CLEANUP_TIMER_UNIT="agent-bridge-tmp-cleanup.timer"

is_allowed_unit() {
  local candidate="$1" allowed
  for allowed in "${ALLOWED_UNITS[@]}"; do [[ "$candidate" == "$allowed" ]] && return 0; done
  return 1
}

die() {
  echo "rollout-agent-bridge: $*" >&2
  exit 1
}

expected_commit=""
authorization_file=""
approved_artifact_sha256=""
approved_evidence_sha256=""
approved_environment=""
qualification_evidence_file=""
deployer_mode="${AGENT_BRIDGE_DEPLOYER_MODE:-0}"
deployer_artifact_sha256="${AGENT_BRIDGE_DEPLOY_ARTIFACT_SHA256:-}"
deployer_environment="${AGENT_BRIDGE_DEPLOY_ENVIRONMENT:-}"
deployer_approval_reference="${AGENT_BRIDGE_DEPLOY_APPROVAL_REFERENCE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-commit) [[ -z "$expected_commit" && -n "${2:-}" ]] || die "invalid or duplicate --expected-commit"; expected_commit="$2"; shift 2 ;;
    --authorization-file) [[ -z "$authorization_file" && -n "${2:-}" ]] || die "invalid or duplicate --authorization-file"; authorization_file="$2"; shift 2 ;;
    --artifact-sha256) [[ -z "$approved_artifact_sha256" && -n "${2:-}" ]] || die "invalid or duplicate --artifact-sha256"; approved_artifact_sha256="$2"; shift 2 ;;
    --evidence-sha256) [[ -z "$approved_evidence_sha256" && -n "${2:-}" ]] || die "invalid or duplicate --evidence-sha256"; approved_evidence_sha256="$2"; shift 2 ;;
    --environment) [[ -z "$approved_environment" && -n "${2:-}" ]] || die "invalid or duplicate --environment"; approved_environment="$2"; shift 2 ;;
    --evidence-file) [[ -z "$qualification_evidence_file" && -n "${2:-}" ]] || die "invalid or duplicate --evidence-file"; qualification_evidence_file="$2"; shift 2 ;;
    *) die "usage: rollout-agent-bridge --expected-commit <40-character SHA> --authorization-file <approval.json> --artifact-sha256 <SHA-256> --evidence-sha256 <SHA-256> --environment <identity> --evidence-file <qualification-evidence.json>" ;;
  esac
done
[[ -n "$expected_commit" ]] || die "missing --expected-commit"
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || die "expected commit must be a full 40-character lowercase SHA"

test_root="${AGENT_BRIDGE_ROLLOUT_TEST_ROOT:-}"
if [[ -n "$test_root" ]]; then
  (( EUID != 0 )) || die "test root is forbidden during root execution"
  [[ "$test_root" == /* && -d "$test_root" ]] || die "invalid test root"
  config_file="$test_root/etc/agent-bridge/rollout.conf"
  lock_file="$test_root/run/lock/agent-bridge-rollout.lock"
  systemctl_cmd="$test_root/bin/systemctl"
  runuser_cmd="$test_root/bin/runuser"
  journalctl_cmd="$test_root/bin/journalctl"
  cp_cmd="$test_root/bin/cp"
  restore_cmd="$test_root/bin/rollout-restore"
  release_stage_cmd="$test_root/bin/release-stage"
  activation_cmd="$test_root/bin/release-activate"
  authorization_validator="$test_root/bin/rollout-authorization-trusted"
  acceptance_validator="$test_root/bin/rollout-acceptance-trusted"
  defaults_dir="$test_root/etc/default"
  systemd_dir="$test_root/etc/systemd/system"
  cgroup_root="$test_root/sys/fs/cgroup"
  systemd_unit_dir="$test_root/systemd"
  smoke_delay=0
  test_mode=1
else
  (( EUID == 0 )) || die "must run as root"
  config_file="/etc/agent-bridge/rollout.conf"
  lock_file="/run/lock/agent-bridge-rollout.lock"
  systemctl_cmd="/usr/bin/systemctl"
  runuser_cmd="/usr/sbin/runuser"
  journalctl_cmd="/usr/bin/journalctl"
  cp_cmd="/usr/bin/cp"
  restore_cmd="/usr/local/libexec/agent-bridge-rollout-restore"
  release_stage_cmd="/usr/local/libexec/agent-bridge-release-stage"
  activation_cmd="/usr/local/libexec/agent-bridge-release-activate"
  authorization_validator="/usr/local/libexec/agent-bridge-rollout-authorization.py"
  acceptance_validator="/usr/local/libexec/agent-bridge-rollout-acceptance.py"
  defaults_dir="/etc/default"
  systemd_dir="/etc/systemd/system"
  cgroup_root="/sys/fs/cgroup"
  systemd_unit_dir="/etc/systemd/system"
  smoke_delay=5
  test_mode=0
fi

for command_path in "$systemctl_cmd" "$runuser_cmd" "$journalctl_cmd" "$cp_cmd" "$restore_cmd" "$release_stage_cmd" /usr/bin/find /usr/bin/flock /usr/bin/git /usr/bin/python3 /usr/bin/sha256sum /usr/bin/tee /usr/bin/realpath /usr/bin/stat /usr/bin/id /usr/bin/mv /usr/bin/rm /usr/bin/cut /usr/bin/sleep /usr/bin/mkdir /usr/bin/chmod /usr/bin/dirname /usr/bin/date /usr/bin/mktemp /usr/bin/ln /usr/bin/hostname /usr/bin/sed /usr/bin/grep /usr/bin/readlink /usr/bin/cat; do
  [[ -x "$command_path" ]] || die "required command is unavailable: $command_path"
done
[[ -f "$config_file" && ! -L "$config_file" ]] || die "missing fixed rollout config: $config_file"
if (( test_mode == 0 )); then
  [[ "$(/usr/bin/stat -c %U "$config_file")" == "root" ]] || die "rollout config must be owned by root"
  config_mode="$(/usr/bin/stat -c %a "$config_file")"
  (( (8#$config_mode & 022) == 0 )) || die "rollout config must not be group/world writable"
fi

project_dir=""
release_root=""
current_pointer=""
rollout_helper_sha256=""
activation_helper_sha256=""
authorization_validator_sha256=""
acceptance_validator_sha256=""
release_stage_sha256=""
rollout_restore_sha256=""
environment_identity=""
runtime_user=""
node_bin=""
backup_dir=""
log_dir=""
declare -a databases=()
declare -a units=()
legacy_health_database=""
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ -n "$value" ]] || die "empty rollout config value for $key"
  case "$key" in
    project_dir) [[ -z "$project_dir" ]] || die "duplicate project_dir"; project_dir="$value" ;;
    release_root) [[ -z "$release_root" ]] || die "duplicate release_root"; release_root="$value" ;;
    current_pointer) [[ -z "$current_pointer" ]] || die "duplicate current_pointer"; current_pointer="$value" ;;
    rollout_helper_sha256) [[ -z "$rollout_helper_sha256" ]] || die "duplicate rollout_helper_sha256"; rollout_helper_sha256="$value" ;;
    activation_helper_sha256) [[ -z "$activation_helper_sha256" ]] || die "duplicate activation_helper_sha256"; activation_helper_sha256="$value" ;;
    authorization_validator_sha256) [[ -z "$authorization_validator_sha256" ]] || die "duplicate authorization_validator_sha256"; authorization_validator_sha256="$value" ;;
    acceptance_validator_sha256) [[ -z "$acceptance_validator_sha256" ]] || die "duplicate acceptance_validator_sha256"; acceptance_validator_sha256="$value" ;;
    release_stage_sha256) [[ -z "$release_stage_sha256" ]] || die "duplicate release_stage_sha256"; release_stage_sha256="$value" ;;
    rollout_restore_sha256) [[ -z "$rollout_restore_sha256" ]] || die "duplicate rollout_restore_sha256"; rollout_restore_sha256="$value" ;;
    environment) [[ -z "$environment_identity" ]] || die "duplicate environment"; environment_identity="$value" ;;
    runtime_user) [[ -z "$runtime_user" ]] || die "duplicate runtime_user"; runtime_user="$value" ;;
    node_bin) [[ -z "$node_bin" ]] || die "duplicate node_bin"; node_bin="$value" ;;
    backup_dir) [[ -z "$backup_dir" ]] || die "duplicate backup_dir"; backup_dir="$value" ;;
    log_dir) [[ -z "$log_dir" ]] || die "duplicate log_dir"; log_dir="$value" ;;
    unit) units+=("$value") ;;
    database) databases+=("$value") ;;
    legacy_database) [[ -z "$legacy_health_database" ]] || die "duplicate legacy_database"; legacy_health_database="$value" ;;
    *) die "unknown rollout config key: $key" ;;
  esac
done < "$config_file"

health_relocation_source=""
health_relocation_target=""

release_mode=0
if [[ -n "$release_root" || -n "$current_pointer" ]]; then
  [[ -n "$release_root" && -n "$current_pointer" ]] || die "release_root and current_pointer must be configured together"
  release_mode=1
fi

cleanup_timer_attempted=0
cleanup_timer_completed=0
cleanup_timer_backup_dir=""
declare -A cleanup_timer_was_present=()
declare -A cleanup_timer_was_enabled=()
declare -A cleanup_timer_was_active=()
if (( release_mode == 1 )); then
  [[ -x "$activation_cmd" ]] || die "release activation helper is unavailable: $activation_cmd"
  if (( test_mode == 0 )) && [[ "$deployer_mode" != 1 ]]; then
    [[ -n "$authorization_file" ]] || die "production rollout requires --authorization-file"
    [[ "$approved_artifact_sha256" =~ ^[0-9a-f]{64}$ ]] || die "production rollout requires --artifact-sha256"
    [[ "$approved_evidence_sha256" =~ ^[0-9a-f]{64}$ ]] || die "production rollout requires --evidence-sha256"
    [[ -n "$qualification_evidence_file" ]] || die "production rollout requires --evidence-file"
    [[ -n "$approved_environment" && "$approved_environment" == "$environment_identity" ]] || die "production rollout environment identity does not match fixed config"
    [[ "$environment_identity" =~ ^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$ ]] || die "environment identity is malformed"
    [[ -x "$authorization_validator" && -x "$acceptance_validator" ]] || die "trusted rollout validators are unavailable"
    [[ "$authorization_validator_sha256" =~ ^[0-9a-f]{64}$ ]] || die "authorization validator SHA-256 pin is missing or malformed"
    [[ "$acceptance_validator_sha256" =~ ^[0-9a-f]{64}$ ]] || die "acceptance validator SHA-256 pin is missing or malformed"
    [[ "$activation_helper_sha256" =~ ^[0-9a-f]{64}$ ]] || die "activation helper SHA-256 pin is missing or malformed"
    [[ "$(/usr/bin/sha256sum "$activation_cmd" | /usr/bin/cut -d' ' -f1)" == "$activation_helper_sha256" ]] || die "activation helper SHA-256 mismatch"
    [[ "$(/usr/bin/sha256sum "$authorization_validator" | /usr/bin/cut -d' ' -f1)" == "$authorization_validator_sha256" ]] || die "authorization validator SHA-256 mismatch"
    [[ "$(/usr/bin/sha256sum "$acceptance_validator" | /usr/bin/cut -d' ' -f1)" == "$acceptance_validator_sha256" ]] || die "acceptance validator SHA-256 mismatch"
    [[ "$release_stage_sha256" =~ ^[0-9a-f]{64}$ ]] || die "release-stage SHA-256 pin is missing or malformed"
    [[ "$rollout_restore_sha256" =~ ^[0-9a-f]{64}$ ]] || die "rollout-restore SHA-256 pin is missing or malformed"
    [[ "$(/usr/bin/sha256sum "$release_stage_cmd" | /usr/bin/cut -d' ' -f1)" == "$release_stage_sha256" ]] || die "release-stage SHA-256 mismatch"
    [[ "$(/usr/bin/sha256sum "$restore_cmd" | /usr/bin/cut -d' ' -f1)" == "$rollout_restore_sha256" ]] || die "rollout-restore SHA-256 mismatch"
  fi
fi
for value_name in runtime_user node_bin backup_dir log_dir; do
  [[ -n "${!value_name}" ]] || die "missing rollout config key: $value_name"
done
if (( release_mode == 0 )); then
  [[ -n "$project_dir" ]] || die "missing rollout config key: project_dir"
  [[ "$project_dir" == /* ]] || die "configured project_dir must be absolute"
  [[ -d "$project_dir" && ! -L "$project_dir" ]] || die "project directory is missing or symlinked"
  [[ "$(/usr/bin/realpath -e "$project_dir")" == "$project_dir" ]] || die "project directory is not canonical"
fi
(( ${#units[@]} > 0 )) || die "fixed unit allowlist must select at least one service"
(( ${#databases[@]} > 0 )) || die "fixed database allowlist must contain at least one entry"
[[ "$node_bin" == /* && "$backup_dir" == /* && "$log_dir" == /* ]] || die "configured paths must be absolute"
[[ -x "$node_bin" && ! -L "$node_bin" ]] || die "configured Node binary is missing or symlinked"
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "invalid runtime user"
if (( test_mode == 0 )); then /usr/bin/id -u "$runtime_user" >/dev/null || die "runtime user does not exist"; fi
rollout_config_sha256="$(/usr/bin/sha256sum "$config_file" | /usr/bin/cut -d' ' -f1)"
installed_helper_sha256="$(/usr/bin/sha256sum "$0" | /usr/bin/cut -d' ' -f1)"
if (( test_mode == 1 )); then
  [[ -n "$authorization_validator_sha256" ]] || authorization_validator_sha256="$(/usr/bin/sha256sum "$authorization_validator" | /usr/bin/cut -d' ' -f1)"
  [[ -n "$acceptance_validator_sha256" ]] || acceptance_validator_sha256="$(/usr/bin/sha256sum "$acceptance_validator" | /usr/bin/cut -d' ' -f1)"
  [[ -n "$release_stage_sha256" ]] || release_stage_sha256="$(/usr/bin/sha256sum "$release_stage_cmd" | /usr/bin/cut -d' ' -f1)"
  [[ -n "$rollout_restore_sha256" ]] || rollout_restore_sha256="$(/usr/bin/sha256sum "$restore_cmd" | /usr/bin/cut -d' ' -f1)"
fi
if [[ "$deployer_mode" == 1 ]]; then
  [[ -n "$deployer_artifact_sha256" && "$deployer_artifact_sha256" =~ ^[0-9a-f]{64}$ ]] || die "deployer artifact SHA-256 is missing or malformed"
  [[ -n "$deployer_environment" && "$deployer_environment" == "$environment_identity" ]] || die "deployer environment does not match fixed config"
  [[ -n "$deployer_approval_reference" ]] || die "deployer approval reference is missing"
  approved_artifact_sha256="$deployer_artifact_sha256"
  approved_environment="$deployer_environment"
fi
authorization_identity_args=(
  --expected-artifact-sha256 "$approved_artifact_sha256"
  --expected-evidence-sha256 "$approved_evidence_sha256"
  --expected-environment "$approved_environment"
  --expected-rollout-helper-sha256 "$installed_helper_sha256"
  --expected-rollout-config-sha256 "$rollout_config_sha256"
  --expected-activation-helper-sha256 "$activation_helper_sha256"
  --expected-authorization-validator-sha256 "$authorization_validator_sha256"
  --expected-acceptance-validator-sha256 "$acceptance_validator_sha256"
  --expected-release-stage-sha256 "$release_stage_sha256"
  --expected-rollout-restore-sha256 "$rollout_restore_sha256"
)

secure_owner_uid="$EUID"
if (( test_mode == 0 )); then secure_owner_uid=0; fi
validate_secure_path() {
  local path="$1" kind="$2" mode owner canonical
  if [[ "$kind" == directory ]]; then [[ -d "$path" && ! -L "$path" ]] || die "$path must be a non-symlink directory"
  else [[ -f "$path" && ! -L "$path" ]] || die "$path must be a non-symlink regular file"
  fi
  canonical="$(/usr/bin/realpath -e "$path")"
  [[ "$canonical" == "$path" ]] || die "$path is not canonical"
  owner="$(/usr/bin/stat -c %u "$path")"
  [[ "$owner" == "$secure_owner_uid" ]] || die "$path has unsafe ownership"
  mode="$(/usr/bin/stat -c %a "$path")"
  (( (8#$mode & 022) == 0 )) || die "$path must not be group/world writable"
}
validate_secure_path "$backup_dir" directory
validate_secure_path "$log_dir" directory
if (( release_mode == 1 )) && [[ "$deployer_mode" != 1 ]] && { [[ -n "$authorization_file" ]] || (( test_mode == 0 )); }; then
  [[ -n "$qualification_evidence_file" ]] || die "authorized release requires --evidence-file"
  validate_secure_path "$qualification_evidence_file" file
  actual_qualification_evidence_sha256="$(/usr/bin/sha256sum "$qualification_evidence_file" | /usr/bin/cut -d' ' -f1)"
  [[ "$actual_qualification_evidence_sha256" == "$approved_evidence_sha256" ]] || die "qualification evidence SHA-256 does not match the approved evidence identity"
fi

if [[ -n "$release_root" || -n "$current_pointer" ]]; then
  [[ "$release_root" == /* && "$current_pointer" == /* ]] || die "release paths must be absolute"
  [[ "$release_root" != *[[:space:]\"\\]* && "$current_pointer" != *[[:space:]\"\\]* ]] || die "release paths must not contain whitespace or shell metacharacters"
  validate_secure_path "$release_root" directory
  [[ "$current_pointer" == "$release_root/current" ]] || die "current pointer must be release_root/current"
  [[ -L "$current_pointer" ]] || die "current pointer must be a valid symlink"
  pointer_target="$(/usr/bin/readlink -- "$current_pointer")"
  [[ "$pointer_target" =~ ^[0-9a-f]{40}$ ]] || die "current pointer target is not a release commit"
  [[ -d "$release_root/$pointer_target" && ! -L "$release_root/$pointer_target" ]] || die "current pointer target does not match expected commit or an installed release"
  active_release_dir="$(/usr/bin/realpath -e "$current_pointer")"
  [[ "$active_release_dir" == "$release_root/$pointer_target" && -d "$active_release_dir" && ! -L "$active_release_dir" ]] || die "current pointer resolves outside a release"
  release_dir="$release_root/$expected_commit"
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || die "expected release directory is missing"
  [[ -f "$active_release_dir/manifest.json" && ! -L "$active_release_dir/manifest.json" ]] || die "active release manifest is missing"
  active_manifest_commit="$(/usr/bin/grep -m1 -oE '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]{40}"' "$active_release_dir/manifest.json" | /usr/bin/sed -E 's/.*"([0-9a-f]{40})"/\1/')"
  [[ "$active_manifest_commit" == "$pointer_target" ]] || die "active release manifest commit does not match pointer"
  [[ -f "$release_dir/manifest.json" && ! -L "$release_dir/manifest.json" ]] || die "active release manifest is missing"
  manifest_commit="$(/usr/bin/grep -m1 -oE '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]{40}"' "$release_dir/manifest.json" | /usr/bin/sed -E 's/.*"([0-9a-f]{40})"/\1/')"
  [[ "$manifest_commit" == "$expected_commit" ]] || die "active release manifest commit does not match expected commit"
  unsafe_release_entry="$(/usr/bin/find "$release_dir" \( -type f -o -type d \) -perm /222 -print -quit)"
  [[ -z "$unsafe_release_entry" ]] || die "active release contains a writable entry: $unsafe_release_entry"
  unsafe_release_owner="$(/usr/bin/find "$release_dir" \( -type f -o -type d \) ! -uid "$secure_owner_uid" -print -quit)"
  [[ -z "$unsafe_release_owner" ]] || die "active release contains an entry with unsafe ownership: $unsafe_release_owner"
  [[ "$(/usr/bin/stat -c %u "$current_pointer")" == "$secure_owner_uid" ]] || die "current pointer has unsafe ownership"
  project_dir="$release_dir"
  [[ "$pointer_target" != "$expected_commit" ]] || die "current pointer already targets expected commit; refusing same-target no-op activation"
  release_mode=1
fi
if (( release_mode == 1 )); then
  if [[ -n "$authorization_file" ]] && [[ "$deployer_mode" != 1 ]]; then
    staging_provenance="$release_root/.${expected_commit}.staging-provenance.json"
    validate_secure_path "$staging_provenance" file
    provenance_commit="$(/usr/bin/grep -m1 -oE '"commit"[[:space:]]*:[[:space:]]*"[0-9a-f]{40}"' "$staging_provenance" | /usr/bin/sed -E 's/.*"([0-9a-f]{40})"/\1/')"
    provenance_artifact_sha256="$(/usr/bin/grep -m1 -oE '"archive_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$staging_provenance" | /usr/bin/sed -E 's/.*"([0-9a-f]{64})"/\1/')"
    [[ "$provenance_commit" == "$expected_commit" && "$provenance_artifact_sha256" == "$approved_artifact_sha256" ]] || die "staging provenance does not match the approved artifact"
  fi
  if [[ -n "$authorization_file" ]] && [[ "$deployer_mode" != 1 ]]; then
    "$authorization_validator" --file "$authorization_file" --expected-commit "$expected_commit" "${authorization_identity_args[@]}" >/dev/null || die "rollout authorization validation failed"
  fi
  "$activation_cmd" --validate-only --release-root "$release_root" --current "$current_pointer" --expected-commit "$expected_commit" || die "active release contract validation failed"
fi
if [[ "$deployer_mode" != 1 ]] && { (( test_mode == 0 )) || [[ -n "$rollout_helper_sha256" ]]; }; then
  [[ "$rollout_helper_sha256" =~ ^[0-9a-f]{64}$ ]] || die "rollout_helper_sha256 must be a full lowercase SHA-256 pin"
  installed_helper_sha256="$(/usr/bin/sha256sum "$0" | /usr/bin/cut -d' ' -f1)"
  [[ "$installed_helper_sha256" == "$rollout_helper_sha256" ]] || die "rollout helper SHA-256 mismatch: configured=$rollout_helper_sha256 installed=$installed_helper_sha256"
fi

declare -A selected_units=()
for unit in "${units[@]}"; do
  is_allowed_unit "$unit" || die "unit is not in the compiled allowlist: $unit"
  [[ -z "${selected_units[$unit]:-}" ]] || die "duplicate selected unit: $unit"
  selected_units[$unit]=1
done

shared_env="$defaults_dir/agent-bridge-shared"
if [[ -e "$shared_env" ]]; then validate_secure_path "$shared_env" file; fi
release_env="$defaults_dir/agent-bridge-release"
validate_secure_path "$release_env" file
systemd_inventory_dir="$log_dir/systemd-inventory-${expected_commit}-$$"
/usr/bin/mkdir --mode=0700 -- "$systemd_inventory_dir"
for inventory_unit in "${ALLOWED_UNITS[@]}"; do
  safe_unit="${inventory_unit%.service}"
  "$systemctl_cmd" cat "$inventory_unit" > "$systemd_inventory_dir/${safe_unit}.cat" || die "systemd unit cannot be captured: $inventory_unit"
  "$systemctl_cmd" show "$inventory_unit" --property=FragmentPath --value > "$systemd_inventory_dir/${safe_unit}.fragment-path" || die "systemd FragmentPath cannot be captured: $inventory_unit"
  "$systemctl_cmd" show "$inventory_unit" --property=DropInPaths --value > "$systemd_inventory_dir/${safe_unit}.drop-in-paths" || die "systemd DropInPaths cannot be captured: $inventory_unit"
  "$systemctl_cmd" show "$inventory_unit" --property=EnvironmentFiles --value > "$systemd_inventory_dir/${safe_unit}.environment-files" || die "systemd EnvironmentFiles cannot be captured: $inventory_unit"
  expected_fragment_path="$systemd_unit_dir/$inventory_unit"
  actual_fragment_path="$(/usr/bin/cat "$systemd_inventory_dir/${safe_unit}.fragment-path")"
  [[ "$actual_fragment_path" == "$expected_fragment_path" ]] || die "FragmentPath mismatch for $inventory_unit"
  actual_drop_in_paths="$(/usr/bin/cat "$systemd_inventory_dir/${safe_unit}.drop-in-paths")"
  [[ -z "$actual_drop_in_paths" ]] || die "unexpected systemd drop-in for $inventory_unit"
done
{
  for inventory_file in "$systemd_inventory_dir"/*; do
    /usr/bin/sha256sum "$inventory_file"
  done
} > "$systemd_inventory_dir/sha256sums"
/usr/bin/chmod 0600 "$systemd_inventory_dir"/*
read_env_key() {
  local file="$1" target_key="$2" line value="$3"
  [[ -e "$file" ]] || { resolved_env_value="$value"; return 0; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" == "$target_key="* ]]; then
      value="${line#*=}"
      [[ -n "$value" && "$value" != *[[:space:]\"\'\\\$]* ]] || die "unsupported or empty $target_key in $file"
    fi
  done < "$file"
  resolved_env_value="$value"
}

declare -A discovered_databases=()
declare -A unit_databases=()
for unit in "${units[@]}"; do
  unit_env="$defaults_dir/${unit%.service}"
  validate_secure_path "$unit_env" file
  expected_environment_files="$shared_env (ignore_errors=yes)"$'\n'"$release_env (ignore_errors=no)"$'\n'"$unit_env (ignore_errors=no)"
  actual_environment_files="$("$systemctl_cmd" show "$unit" --property=EnvironmentFiles --value)"
  [[ "$actual_environment_files" == "$expected_environment_files" ]] || die "effective EnvironmentFiles mismatch for $unit"
  db_key=DB_PATH
  [[ "$unit" == "agent-bridge-health.service" ]] && db_key=HEALTH_DB_PATH
  explicit_environment="$("$systemctl_cmd" show "$unit" --property=Environment --value)"
  [[ " $explicit_environment " != *" $db_key="* ]] || die "explicit systemd $db_key override is unsupported for $unit"
  if (( release_mode == 1 )); then
    [[ " $explicit_environment " != *" BRIDGE_CURRENT_RELEASE_DIR="* ]] || die "explicit systemd BRIDGE_CURRENT_RELEASE_DIR override is unsupported for $unit"
    resolved_env_value=""
    read_env_key "$shared_env" BRIDGE_CURRENT_RELEASE_DIR ""
    read_env_key "$release_env" BRIDGE_CURRENT_RELEASE_DIR "$resolved_env_value"
    inherited_release_pointer="$resolved_env_value"
    read_env_key "$unit_env" BRIDGE_CURRENT_RELEASE_DIR "$inherited_release_pointer"
    [[ "$resolved_env_value" == "$current_pointer" ]] || die "active release pointer mismatch for $unit"
  fi
  resolved_env_value=""
  read_env_key "$shared_env" "$db_key" ""
  read_env_key "$release_env" "$db_key" "$resolved_env_value"
  inherited_value="$resolved_env_value"
  read_env_key "$unit_env" "$db_key" "$inherited_value"
  discovered="$resolved_env_value"
  [[ "$discovered" == /* ]] || die "$unit would use a missing, relative, or defaulted $db_key"
  if [[ "$unit" == "agent-bridge-health.service" && ! -f "$discovered" && -n "$legacy_health_database" ]]; then
    [[ ! -e "$discovered" && ! -L "$discovered" ]] || die "health database target is occupied by a non-regular path: $discovered"
    [[ "$legacy_health_database" == /* && -f "$legacy_health_database" && ! -L "$legacy_health_database" ]] || die "legacy health database is missing or symlinked: $legacy_health_database"
    health_relocation_source="$legacy_health_database"
    health_relocation_target="$discovered"
    discovered="$legacy_health_database"
  fi
  [[ -f "$discovered" && ! -L "$discovered" ]] || die "missing database or symlinked database for $unit: $discovered"
  canonical="$(/usr/bin/realpath -e "$discovered")"
  [[ "$canonical" == "$discovered" ]] || die "database path for $unit is not canonical: $discovered"
  unit_databases[$unit]="$canonical"
  discovered_databases[$canonical]=1
done

declare -A canonical_databases=()
for database_index in "${!databases[@]}"; do
  database="${databases[$database_index]}"
  [[ "$database" == /* && "$database" != *[[:space:]]* ]] || die "database allowlist entries must be canonical absolute paths without whitespace"
  if [[ -n "$health_relocation_target" && "$database" == "$health_relocation_target" ]]; then
    [[ -n "$health_relocation_source" ]] || die "health relocation source is unavailable"
    databases[$database_index]="$health_relocation_source"
    database="$health_relocation_source"
  fi
  [[ -f "$database" && ! -L "$database" ]] || die "missing database or symlinked database: $database"
  canonical="$(/usr/bin/realpath -e "$database")"
  [[ "$canonical" == "$database" ]] || die "database path is not canonical: $database"
  [[ -z "${canonical_databases[$canonical]:-}" ]] || die "duplicate database allowlist entry: $database"
  canonical_databases[$canonical]=1
done
(( ${#canonical_databases[@]} == ${#discovered_databases[@]} )) || die "configured and discovered database inventory counts differ"
for database in "${!canonical_databases[@]}"; do [[ -n "${discovered_databases[$database]:-}" ]] || die "extra configured database not selected by any unit: $database"; done
for database in "${!discovered_databases[@]}"; do [[ -n "${canonical_databases[$database]:-}" ]] || die "discovered database missing from root allowlist: $database"; done

run_as_runtime() {
  "$runuser_cmd" --user "$runtime_user" -- "$@"
}
git_check() {
  [[ "$(run_as_runtime /usr/bin/git -C "$project_dir" rev-parse --is-inside-work-tree)" == "true" ]] || die "project is not a Git worktree"
  [[ "$(run_as_runtime /usr/bin/git -C "$project_dir" branch --show-current)" == "main" ]] || die "project must be on main"
  actual_commit="$(run_as_runtime /usr/bin/git -C "$project_dir" rev-parse HEAD)"
  [[ "$actual_commit" == "$expected_commit" ]] || die "expected commit $expected_commit but found $actual_commit"
  [[ -z "$(run_as_runtime /usr/bin/git -C "$project_dir" status --porcelain --untracked-files=normal)" ]] || die "project must have a clean working tree"
}
code_check() {
  if (( release_mode == 1 )); then
    [[ -f "$project_dir/scripts/rollout-db.ts" && ! -L "$project_dir/scripts/rollout-db.ts" ]] || die "migration helper is missing from active release"
    [[ -f "$project_dir/scripts/rollout-db-impl.ts" && ! -L "$project_dir/scripts/rollout-db-impl.ts" ]] || die "database implementation helper is missing from active release"
    [[ -f "$project_dir/node_modules/tsx/dist/cli.mjs" && ! -L "$project_dir/node_modules/tsx/dist/cli.mjs" ]] || die "tsx runtime is missing from active release"
  else
    git_check
  fi
}

cleanup_manifest_hash() {
  local manifest="$1" wanted="$2"
  /usr/bin/python3 - "$manifest" "$wanted" <<'PY'
import json
import sys

manifest_path, wanted_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
for entry in manifest.get("files", []):
    if entry.get("path") == wanted_path:
        print(entry.get("sha256", ""))
        break
PY
}

validate_cleanup_artifact() {
  (( release_mode == 1 )) || die "cleanup timer installation requires immutable release mode"
  local manifest="$project_dir/manifest.json" path expected actual
  [[ -f "$manifest" && ! -L "$manifest" ]] || die "cleanup artifact manifest is missing"
  for path in \
    scripts/reap-tmp-artifacts.sh \
    systemd/$CLEANUP_SERVICE_UNIT \
    systemd/$CLEANUP_TIMER_UNIT; do
    [[ -f "$project_dir/$path" && ! -L "$project_dir/$path" ]] || die "cleanup artifact is missing: $path"
    expected="$(cleanup_manifest_hash "$manifest" "$path")"
    [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "cleanup artifact is not listed in the release manifest: $path"
    actual="$(/usr/bin/sha256sum "$project_dir/$path" | /usr/bin/cut -d' ' -f1)"
    [[ "$actual" == "$expected" ]] || die "cleanup artifact manifest hash mismatch: $path expected=$expected actual=$actual"
  done
  /usr/bin/grep -Fq 'BRIDGE_CURRENT_RELEASE_DIR' "$project_dir/systemd/$CLEANUP_SERVICE_UNIT" || die "cleanup service is not release-pointer bound"
  /usr/bin/grep -Fq 'scripts/reap-tmp-artifacts.sh' "$project_dir/systemd/$CLEANUP_SERVICE_UNIT" || die "cleanup service does not invoke the packaged reaper"
}

rollback_cleanup_timer() {
  (( cleanup_timer_attempted == 1 && cleanup_timer_completed == 0 )) || return 0
  local unit source destination marker
  echo "rollback cleanup timer: restoring prior unit files and state"
  "$systemctl_cmd" stop "$CLEANUP_TIMER_UNIT" >/dev/null 2>&1 || true
  "$systemctl_cmd" disable "$CLEANUP_TIMER_UNIT" >/dev/null 2>&1 || true
  for unit in "$CLEANUP_SERVICE_UNIT" "$CLEANUP_TIMER_UNIT"; do
    destination="$systemd_dir/$unit"
    marker="$cleanup_timer_backup_dir/$unit.absent"
    if [[ -f "$cleanup_timer_backup_dir/$unit" ]]; then
      /usr/bin/cp -f -- "$cleanup_timer_backup_dir/$unit" "$destination"
      /usr/bin/chmod 0644 "$destination"
    elif [[ -f "$marker" ]]; then
      /usr/bin/rm -f -- "$destination"
    else
      echo "rollback cleanup timer: missing backup state for $unit" >&2
      return 1
    fi
  done
  "$systemctl_cmd" daemon-reload >/dev/null 2>&1 || return 1
  if [[ "${cleanup_timer_was_enabled[$CLEANUP_TIMER_UNIT]:-0}" == 1 ]]; then
    "$systemctl_cmd" enable "$CLEANUP_TIMER_UNIT" >/dev/null 2>&1 || return 1
  else
    "$systemctl_cmd" disable "$CLEANUP_TIMER_UNIT" >/dev/null 2>&1 || return 1
  fi
  if [[ "${cleanup_timer_was_active[$CLEANUP_TIMER_UNIT]:-0}" == 1 ]]; then
    "$systemctl_cmd" start "$CLEANUP_TIMER_UNIT" >/dev/null 2>&1 || return 1
  else
    "$systemctl_cmd" stop "$CLEANUP_TIMER_UNIT" >/dev/null 2>&1 || true
  fi
  echo "rollback cleanup timer: restored"
  return 0
}

install_cleanup_timer() {
  validate_cleanup_artifact
  cleanup_timer_attempted=1
  cleanup_timer_backup_dir="$artifact_dir/cleanup-unit-backup"
  /usr/bin/mkdir --mode=0700 -- "$cleanup_timer_backup_dir"
  local unit source destination temporary
  for unit in "$CLEANUP_SERVICE_UNIT" "$CLEANUP_TIMER_UNIT"; do
    source="$project_dir/systemd/$unit"
    destination="$systemd_dir/$unit"
    if [[ -e "$destination" || -L "$destination" ]]; then
      [[ -f "$destination" && ! -L "$destination" ]] || die "existing cleanup unit is not a regular file: $destination"
      /usr/bin/cp -f -- "$destination" "$cleanup_timer_backup_dir/$unit"
      cleanup_timer_was_present[$unit]=1
    else
      : > "$cleanup_timer_backup_dir/$unit.absent"
      cleanup_timer_was_present[$unit]=0
    fi
    if "$systemctl_cmd" is-enabled --quiet "$unit"; then cleanup_timer_was_enabled[$unit]=1; else cleanup_timer_was_enabled[$unit]=0; fi
    if "$systemctl_cmd" is-active --quiet "$unit"; then cleanup_timer_was_active[$unit]=1; else cleanup_timer_was_active[$unit]=0; fi
    temporary="$(/usr/bin/mktemp --tmpdir="$systemd_dir" ".${unit}.XXXXXX")"
    /usr/bin/cp -f -- "$source" "$temporary"
    /usr/bin/chmod 0644 "$temporary"
    /usr/bin/mv -f -- "$temporary" "$destination"
  done
  "$systemctl_cmd" daemon-reload || die "cleanup timer daemon-reload failed"
  "$systemctl_cmd" enable "$CLEANUP_TIMER_UNIT" || die "cleanup timer enable failed"
  "$systemctl_cmd" start "$CLEANUP_TIMER_UNIT" || die "cleanup timer start failed"
  "$systemctl_cmd" is-enabled --quiet "$CLEANUP_TIMER_UNIT" || die "cleanup timer is not enabled"
  local active_state schedule
  active_state="$($systemctl_cmd show "$CLEANUP_TIMER_UNIT" --property=ActiveState --value)"
  [[ "$active_state" == active ]] || die "cleanup timer is not active: $active_state"
  schedule="$($systemctl_cmd show "$CLEANUP_TIMER_UNIT" --property=TimersCalendar --value)"
  [[ -n "$schedule" && "$schedule" != "n/a" ]] || die "cleanup timer schedule is missing"
  for unit in "$CLEANUP_SERVICE_UNIT" "$CLEANUP_TIMER_UNIT"; do
    [[ "$(/usr/bin/sha256sum "$project_dir/systemd/$unit" | /usr/bin/cut -d' ' -f1)" == "$(/usr/bin/sha256sum "$systemd_dir/$unit" | /usr/bin/cut -d' ' -f1)" ]] || die "installed cleanup unit hash mismatch: $unit"
  done
  cleanup_timer_completed=1
  echo "cleanup timer installed and verified schedule=$schedule"
}

assert_service_active() {
  local unit="$1" active_state sub_state
  if ! "$systemctl_cmd" is-active --quiet "$unit"; then
    echo "service is not active: $unit" >&2
    return 1
  fi
  if "$systemctl_cmd" is-failed --quiet "$unit"; then
    echo "service is failed: $unit" >&2
    return 1
  fi
  if ! active_state="$("$systemctl_cmd" show "$unit" --property=ActiveState --value)" \
    || ! sub_state="$("$systemctl_cmd" show "$unit" --property=SubState --value)"; then
    echo "service state could not be read: $unit" >&2
    return 1
  fi
  if [[ "$active_state" != active || "$sub_state" != running ]]; then
    echo "service is not stably running: $unit state=$active_state/$sub_state" >&2
    return 1
  fi
}
assert_service_ready_for_rollout() {
  local unit="$1" active_state sub_state
  active_state="$($systemctl_cmd show "$unit" --property=ActiveState --value)"
  sub_state="$($systemctl_cmd show "$unit" --property=SubState --value)"
  case "$active_state/$sub_state" in
    active/running) assert_service_active "$unit" ;;
    inactive/dead|inactive/exited|failed/dead|failed/failed) ;;
    *) die "service is not in a quiesceable state: $unit state=$active_state/$sub_state" ;;
  esac
}

backup_databases() {
  /usr/bin/mkdir --mode=0700 -- "$backup_set"
  printf 'index\tsource\tbackup\tuid\tgid\tmode\tsize\tsource_sha256\tbackup_sha256\tparent_device\tparent_inode\tparent_uid\tparent_gid\tparent_mode\n' > "$manifest"
  local index source source_dir backup uid gid mode size source_hash backup_hash backup_canonical
  local parent_device parent_inode parent_uid parent_gid parent_mode
  for index in "${!databases[@]}"; do
    source="${databases[$index]}"
    source_dir="$(/usr/bin/dirname "$source")"
    [[ -d "$source_dir" && ! -L "$source_dir" && "$(/usr/bin/realpath -e "$source_dir")" == "$source_dir" ]] || die "database parent is unsafe: $source_dir"
    [[ ! -e "${source}-wal" && ! -e "${source}-shm" ]] || die "database has live WAL/SHM sidecars after service stop: $source"
    backup="$backup_set/$(printf '%02d' "$((index + 1))")-${source##*/}"
    expected_backups[$index]="$backup"
    [[ ! -e "$backup" && ! -L "$backup" ]] || die "backup destination already exists: $backup"
    uid="$(/usr/bin/stat -c %u "$source")"
    gid="$(/usr/bin/stat -c %g "$source")"
    mode="$(/usr/bin/stat -c %a "$source")"
    size="$(/usr/bin/stat -c %s "$source")"
    source_hash="$(/usr/bin/sha256sum "$source" | /usr/bin/cut -d' ' -f1)"
    parent_device="$(/usr/bin/stat -c %d "$source_dir")"
    parent_inode="$(/usr/bin/stat -c %i "$source_dir")"
    parent_uid="$(/usr/bin/stat -c %u "$source_dir")"
    parent_gid="$(/usr/bin/stat -c %g "$source_dir")"
    parent_mode="$(/usr/bin/stat -c %a "$source_dir")"
    "$cp_cmd" --preserve=all --no-dereference -- "$source" "$backup"
    [[ -f "$backup" && ! -L "$backup" ]] || die "backup is not a regular file: $backup"
    backup_canonical="$(/usr/bin/realpath -e "$backup")"
    [[ "$backup_canonical" == "$backup" && "$(/usr/bin/dirname "$backup")" == "$backup_set" ]] || die "backup escaped fixed backup directory: $backup"
    backup_hash="$(/usr/bin/sha256sum "$backup" | /usr/bin/cut -d' ' -f1)"
    [[ "$source_hash" == "$backup_hash" ]] || die "byte-exact backup verification failed: $source"
    [[ "$(/usr/bin/stat -c %u "$backup")" == "$uid" && "$(/usr/bin/stat -c %g "$backup")" == "$gid" && "$(/usr/bin/stat -c %a "$backup")" == "$mode" && "$(/usr/bin/stat -c %s "$backup")" == "$size" ]] || die "backup metadata verification failed: $source"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$index" "$source" "$backup" "$uid" "$gid" "$mode" "$size" "$source_hash" "$backup_hash" "$parent_device" "$parent_inode" "$parent_uid" "$parent_gid" "$parent_mode" >> "$manifest"
  done
}

restore_backups() {
  [[ -s "$manifest" ]] || return 0
  echo "restoring pre-rollout databases from $manifest"
  local restore_failed=0 restored_count=0
  local index source source_dir backup uid gid mode size source_hash backup_hash actual_backup_hash
  local parent_device parent_inode parent_uid parent_gid parent_mode
  while IFS=$'\t' read -r index source backup uid gid mode size source_hash backup_hash parent_device parent_inode parent_uid parent_gid parent_mode; do
    [[ "$index" == "index" ]] && continue
    [[ "$index" =~ ^[0-9]+$ && "$index" == "$restored_count" ]] || { echo "invalid rollback manifest index: $index" >&2; restore_failed=1; continue; }
    [[ "$source" == "${databases[$index]:-}" && "$backup" == "${expected_backups[$index]:-}" ]] || { echo "rollback manifest path mismatch at index $index" >&2; restore_failed=1; continue; }
    source_dir="$(/usr/bin/dirname "$source")"
    [[ -f "$source" && ! -L "$source" && -f "$backup" && ! -L "$backup" ]] || { echo "unsafe rollback source or backup at index $index" >&2; restore_failed=1; continue; }
    [[ "$(/usr/bin/realpath -e "$source")" == "$source" && "$(/usr/bin/realpath -e "$backup")" == "$backup" && "$(/usr/bin/dirname "$backup")" == "$backup_set" ]] || { echo "rollback path escaped fixed inventory at index $index" >&2; restore_failed=1; continue; }
    [[ -d "$source_dir" && ! -L "$source_dir" && "$(/usr/bin/realpath -e "$source_dir")" == "$source_dir" && "$(/usr/bin/stat -c %d "$source_dir")" == "$parent_device" && "$(/usr/bin/stat -c %i "$source_dir")" == "$parent_inode" && "$(/usr/bin/stat -c %u "$source_dir")" == "$parent_uid" && "$(/usr/bin/stat -c %g "$source_dir")" == "$parent_gid" && "$(/usr/bin/stat -c %a "$source_dir")" == "$parent_mode" ]] || { echo "rollback parent metadata mismatch at index $index" >&2; restore_failed=1; continue; }
    actual_backup_hash="$(/usr/bin/sha256sum "$backup" | /usr/bin/cut -d' ' -f1)"
    [[ "$source_hash" == "$backup_hash" && "$actual_backup_hash" == "$backup_hash" && "$(/usr/bin/stat -c %u "$backup")" == "$uid" && "$(/usr/bin/stat -c %g "$backup")" == "$gid" && "$(/usr/bin/stat -c %a "$backup")" == "$mode" && "$(/usr/bin/stat -c %s "$backup")" == "$size" ]] || { echo "rollback backup metadata/hash mismatch at index $index" >&2; restore_failed=1; continue; }
    if ! "$restore_cmd" --source "$source" --backup "$backup" --uid "$uid" --gid "$gid" --mode "$mode" --size "$size" --sha256 "$source_hash" --parent-device "$parent_device" --parent-inode "$parent_inode" --parent-uid "$parent_uid" --parent-gid "$parent_gid" --parent-mode "$parent_mode"; then
      echo "descriptor-based rollback failed: $source" >&2; restore_failed=1; continue
    fi
    /usr/bin/rm -f -- "${source}-wal" "${source}-shm"
    [[ "$(/usr/bin/sha256sum "$source" | /usr/bin/cut -d' ' -f1)" == "$source_hash" && "$(/usr/bin/stat -c %u "$source")" == "$uid" && "$(/usr/bin/stat -c %g "$source")" == "$gid" && "$(/usr/bin/stat -c %a "$source")" == "$mode" && "$(/usr/bin/stat -c %s "$source")" == "$size" ]] || { echo "restored database verification failed: $source" >&2; restore_failed=1; continue; }
    restored_count=$((restored_count + 1))
  done < "$manifest"
  (( restored_count == ${#databases[@]} )) || restore_failed=1
  (( restore_failed == 0 )) || { echo "ROLLBACK INCOMPLETE; services remain stopped" >&2; return 1; }
  echo "database rollback completed with metadata and hashes verified"
}

restore_previous_release_and_start() {
  (( release_mode == 1 )) || return 0
  [[ "$previous_pointer_target" =~ ^[0-9a-f]{40}$ ]] || { echo "previous release pointer target is unavailable" >&2; return 1; }
  record_recovery_phase POINTER_ROLLBACK_STARTED || return 1
  "$activation_cmd" --release-root "$release_root" --current "$current_pointer" --expected-commit "$previous_pointer_target" || { recontain_after_recovery_failure; return 1; }
  if [[ "$(/usr/bin/readlink -- "$current_pointer")" != "$previous_pointer_target" ]]; then
    echo "previous release pointer verification failed" >&2
    recontain_after_recovery_failure
    return 1
  fi
  record_recovery_phase POINTER_ROLLED_BACK || return 1
  echo "restarting verified previous release commit=$previous_pointer_target"
  "$systemctl_cmd" reset-failed "${units[@]}" || { recontain_after_recovery_failure; return 1; }
  declare -A recovery_restart_baseline=()
  for unit in "${units[@]}"; do
    if ! recovery_restart_baseline[$unit]="$( "$systemctl_cmd" show "$unit" --property=NRestarts --value )" \
      || [[ ! "${recovery_restart_baseline[$unit]}" =~ ^[0-9]+$ ]]; then
      echo "invalid recovery NRestarts baseline for $unit" >&2
      recontain_after_recovery_failure
      return 1
    fi
  done
  local recovery_since startup_errors current_restarts recovery_evidence recovery_queue_evidence
  local -a recovery_journal_args=()
  for unit in "${units[@]}"; do recovery_journal_args+=(-u "$unit"); done
  recovery_since="$(/usr/bin/date -u '+%Y-%m-%d %H:%M:%S UTC')"
  record_recovery_phase PREVIOUS_RELEASE_STARTING || return 1
  "$systemctl_cmd" start "${units[@]}" || { recontain_after_recovery_failure; return 1; }
  for unit in "${units[@]}"; do assert_service_active "$unit" || { recontain_after_recovery_failure; return 1; }; done
  (( smoke_delay > 0 )) && /usr/bin/sleep "$smoke_delay"
  for unit in "${units[@]}"; do assert_service_active "$unit" || { recontain_after_recovery_failure; return 1; }; done
  startup_errors="$($journalctl_cmd --since "$recovery_since" --priority err --no-pager "${recovery_journal_args[@]}" 2>&1)" || { recontain_after_recovery_failure; return 1; }
  [[ -z "$startup_errors" || "$startup_errors" == "-- No entries --" ]] || { echo "previous release journal smoke failed" >&2; recontain_after_recovery_failure; return 1; }
  for unit in "${units[@]}"; do
    if ! current_restarts="$($systemctl_cmd show "$unit" --property=NRestarts --value)" \
      || [[ ! "$current_restarts" =~ ^[0-9]+$ ]]; then
      echo "invalid recovery NRestarts reading for $unit" >&2
      recontain_after_recovery_failure
      return 1
    fi
    if [[ "$current_restarts" != "${recovery_restart_baseline[$unit]}" ]]; then
      echo "previous release restart stability failed" >&2
      recontain_after_recovery_failure
      return 1
    fi
  done
  recovery_evidence="$artifact_dir/recovery-acceptance-evidence.json"
  run_db_tool inspect --evidence - "${db_args[@]}" > "$recovery_evidence" || { recontain_after_recovery_failure; return 1; }
  if ! hash_evidence_file "$recovery_evidence"; then
    echo "recovery acceptance evidence hashing failed" >&2
    recontain_after_recovery_failure
    return 1
  fi
  recovery_queue_evidence="$artifact_dir/recovery-queue-evidence.json"
  run_db_tool inspect --evidence - "${db_args[@]}" > "$recovery_queue_evidence" || { recontain_after_recovery_failure; return 1; }
  if ! hash_evidence_file "$recovery_queue_evidence"; then
    echo "recovery queue evidence hashing failed" >&2
    recontain_after_recovery_failure
    return 1
  fi
  record_recovery_phase PREVIOUS_RELEASE_ACCEPTED || return 1
  recovery_running=1
  return 0
}

hash_evidence_file() {
  local evidence_file="$1" sidecar="${1%.json}.sha256"
  [[ -f "$evidence_file" && ! -L "$evidence_file" ]] || return 1
  if (( test_mode == 1 )) && [[ "${FAKE_FAIL_RECOVERY_EVIDENCE_HASH:-}" == 1 && "$evidence_file" == *recovery-* ]]; then
    return 1
  fi
  /usr/bin/sha256sum "$evidence_file" > "$sidecar" || return 1
  [[ -f "$sidecar" && ! -L "$sidecar" && -s "$sidecar" ]]
}

record_phase() {
  local phase_name="$1"
  if (( test_mode == 1 )) && [[ "$phase_name" == FAILED_RESTORED && "${FAKE_FAIL_TERMINAL_RECOVERY_LEDGER:-}" == 1 ]]; then
    return 1
  fi
  printf 'phase=%s timestamp=%s\n' "$phase_name" "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$phase_ledger"
  /usr/bin/sha256sum "$phase_ledger" > "$phase_ledger.sha256"
}

stop_and_verify_all_services() {
  local stop_ok=1 verify_ok=1 unit active_state sub_state result exec_main_code exec_main_status
  local main_pid control_pid control_group cgroup_path cgroup_file pid pair_ok value index
  local cgroup_list_file procs_content
  local -a cgroup_files=()
  local evidence_name="${1:-containment-evidence.json}" evidence_file="$artifact_dir/${1:-containment-evidence.json}" first_unit=1
  local -a remaining_pids=()
  if ! "$systemctl_cmd" stop "${units[@]}"; then stop_ok=0; fi
  printf '{\n  "createdAt": "%s",\n  "stopCommandSucceeded": %s,\n  "units": [\n' \
    "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$([[ "$stop_ok" == 1 ]] && echo true || echo false)" > "$evidence_file"
  for unit in "${units[@]}"; do
    if ! active_state="$("$systemctl_cmd" show "$unit" --property=ActiveState --value 2>/dev/null)" \
      || ! sub_state="$("$systemctl_cmd" show "$unit" --property=SubState --value 2>/dev/null)" \
      || ! result="$("$systemctl_cmd" show "$unit" --property=Result --value 2>/dev/null)" \
      || ! exec_main_code="$("$systemctl_cmd" show "$unit" --property=ExecMainCode --value 2>/dev/null)" \
      || ! exec_main_status="$("$systemctl_cmd" show "$unit" --property=ExecMainStatus --value 2>/dev/null)" \
      || ! main_pid="$("$systemctl_cmd" show "$unit" --property=MainPID --value 2>/dev/null)" \
      || ! control_pid="$("$systemctl_cmd" show "$unit" --property=ControlPID --value 2>/dev/null)" \
      || ! control_group="$("$systemctl_cmd" show "$unit" --property=ControlGroup --value 2>/dev/null)"; then
      verify_ok=0
      active_state=unknown; sub_state=unknown; result=unknown; exec_main_code=unknown; exec_main_status=unknown
      main_pid=unknown; control_pid=unknown; control_group=unknown
    fi
    for value in "$active_state" "$sub_state" "$result" "$exec_main_code" "$exec_main_status" "$main_pid" "$control_pid"; do
      [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]] || verify_ok=0
    done
    [[ -z "$control_group" || ( "$control_group" == /* && "$control_group" != *..* && "$control_group" =~ ^/[A-Za-z0-9_@./:-]+$ ) ]] || verify_ok=0
    pair_ok=0
    [[ "$active_state" == inactive && ( "$sub_state" == dead || "$sub_state" == exited ) ]] && pair_ok=1
    [[ "$active_state" == failed && ( "$sub_state" == dead || "$sub_state" == failed ) ]] && pair_ok=1
    (( pair_ok == 1 )) || verify_ok=0
    [[ "$main_pid" == 0 && "$control_pid" == 0 ]] || verify_ok=0
    remaining_pids=()
    if [[ -n "$control_group" ]]; then
      if [[ "$control_group" != /* || "$control_group" == *..* ]]; then
        verify_ok=0
      else
        cgroup_path="$cgroup_root$control_group"
        if [[ ! -d "$cgroup_path" || -L "$cgroup_path" ]]; then
          verify_ok=0
        else
          cgroup_list_file="$(/usr/bin/mktemp)"
          cgroup_files=()
          if ! /usr/bin/find "$cgroup_path" -type f -name cgroup.procs -print0 > "$cgroup_list_file" 2>/dev/null; then
            verify_ok=0
          else
            mapfile -d '' -t cgroup_files < "$cgroup_list_file"
            for cgroup_file in "${cgroup_files[@]}"; do
              [[ -z "$cgroup_file" ]] && continue
              if ! procs_content="$(< "$cgroup_file")" 2>/dev/null; then
                verify_ok=0
                continue
              fi
              while IFS= read -r pid || [[ -n "$pid" ]]; do
                [[ -z "$pid" ]] && continue
                if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then remaining_pids+=("$pid"); else verify_ok=0; fi
              done <<< "$procs_content"
            done
          fi
          /usr/bin/rm -f -- "$cgroup_list_file"
        fi
      fi
    fi
    (( ${#remaining_pids[@]} == 0 )) || verify_ok=0
    (( first_unit == 1 )) || printf ',\n' >> "$evidence_file"
    first_unit=0
    printf '    {"unit":"%s","ActiveState":"%s","SubState":"%s","Result":"%s","ExecMainCode":"%s","ExecMainStatus":"%s","MainPID":%s,"ControlPID":%s,"ControlGroup":"%s","remainingCgroupPids":[' \
      "$unit" "$active_state" "$sub_state" "$result" "$exec_main_code" "$exec_main_status" \
      "$([[ "$main_pid" =~ ^[0-9]+$ ]] && echo "$main_pid" || echo -1)" \
      "$([[ "$control_pid" =~ ^[0-9]+$ ]] && echo "$control_pid" || echo -1)" "$control_group" >> "$evidence_file"
    for index in "${!remaining_pids[@]}"; do
      (( index == 0 )) || printf ',' >> "$evidence_file"
      printf '%s' "${remaining_pids[$index]}" >> "$evidence_file"
    done
    printf ']}' >> "$evidence_file"
  done
  printf '\n  ]\n}\n' >> "$evidence_file"
  if ! /usr/bin/sha256sum "$evidence_file" > "$artifact_dir/${evidence_name%.json}.sha256"; then
    verify_ok=0
  fi
  if (( verify_ok == 0 )); then
    echo "CONTAINMENT INCOMPLETE: stop_ok=$stop_ok verify_ok=$verify_ok" >&2
    return 1
  fi
  (( stop_ok == 1 )) || echo "systemctl stop returned nonzero; containment independently verified" >&2
  echo "all selected services verified stopped"
}

recontain_after_recovery_failure() {
  containment_verified=0
  if stop_and_verify_all_services rollback-containment-evidence.json; then
    containment_verified=1
  else
    echo "recovery containment could not be re-proven; services remain in an uncertain state" >&2
  fi
  return 1
}

record_recovery_phase() {
  local phase_name="$1"
  if ! record_phase "$phase_name"; then
    echo "failed to durably record recovery phase=$phase_name" >&2
    recontain_after_recovery_failure
    return 1
  fi
}

validate_sqlite_sidecars() {
  local database sidecar
  for database in "${databases[@]}"; do
    for sidecar in "${database}-wal" "${database}-shm"; do
      if [[ -e "$sidecar" || -L "$sidecar" ]]; then
        [[ -f "$sidecar" && ! -L "$sidecar" ]] || die "SQLite sidecar is not a regular non-symlink file: $sidecar"
      fi
    done
  done
}

clear_stale_sqlite_sidecars() {
  local database wal_size
  validate_sqlite_sidecars
  for database in "${databases[@]}"; do
    if [[ -e "${database}-wal" ]]; then
      wal_size="$(/usr/bin/stat -c %s "${database}-wal")"
      [[ "$wal_size" =~ ^[0-9]+$ ]] || die "unable to determine SQLite WAL size: ${database}-wal"
      (( wal_size == 0 )) || die "database has a non-empty WAL after offline checkpoint: $database"
    fi
    if [[ -e "${database}-wal" || -e "${database}-shm" ]]; then
      echo "clear-stale-sidecars database=$database"
      /usr/bin/rm -f -- "${database}-wal" "${database}-shm"
      [[ ! -e "${database}-wal" && ! -L "${database}-wal" && ! -e "${database}-shm" && ! -L "${database}-shm" ]] || die "failed to clear stale SQLite sidecars: $database"
    fi
  done
}

# Removes the sentinel only when sentinel_removable=1 was explicitly set —
# never inferred from $? (the script's own exit status stays nonzero on
# every failure path, including a cleanly auto-restored one, so exit code
# alone can never signal "safe to retry"). Fail-closed: this only reports
# success once it has positively re-verified that the sentinel still is the
# exact one this invocation created (matched by device:inode, captured in
# $sentinel_identity right after creation) and that it is genuinely gone
# afterward. A sentinel that is missing, symlinked, non-regular, or no
# longer matches that identity is never silently treated as "already fine"
# — each of those is its own cleanup failure requiring manual review, not a
# no-op.
remove_sentinel_if_removable() {
  (( sentinel_removable == 1 )) || return 0
  if [[ -z "${sentinel_identity:-}" ]]; then
    echo "SENTINEL CLEANUP FAILED: no sentinel identity recorded for this invocation — manual review required" >&2
    return 1
  fi
  if [[ ! -e "$sentinel_path" && ! -L "$sentinel_path" ]]; then
    echo "SENTINEL CLEANUP FAILED: sentinel unexpectedly missing before this invocation could remove it: $sentinel_path — manual review required" >&2
    return 1
  fi
  if [[ -L "$sentinel_path" || ! -f "$sentinel_path" ]]; then
    echo "SENTINEL CLEANUP FAILED: sentinel changed shape (symlink or non-regular) before removal, refusing to touch it: $sentinel_path — manual review required" >&2
    return 1
  fi
  local current_identity
  current_identity="$(/usr/bin/stat -c '%d:%i' "$sentinel_path" 2>/dev/null || true)"
  if [[ "$current_identity" != "$sentinel_identity" ]]; then
    echo "SENTINEL CLEANUP FAILED: sentinel at $sentinel_path is no longer the one this invocation created (identity mismatch) — manual review required" >&2
    return 1
  fi
  if ! /usr/bin/rm -f -- "$sentinel_path"; then
    echo "SENTINEL CLEANUP FAILED: rm failed for $sentinel_path — manual review required" >&2
    return 1
  fi
  if [[ -e "$sentinel_path" || -L "$sentinel_path" ]]; then
    echo "SENTINEL CLEANUP FAILED: sentinel still present after removal attempt: $sentinel_path — manual review required" >&2
    return 1
  fi
  echo "rollout sentinel removed: $sentinel_path"
  return 0
}

on_exit() {
  status=$?
  set +e
  if ! rollback_cleanup_timer; then
    status=1
    echo "rollback cleanup timer failed; manual review required" >&2
  fi
  if (( status == 0 && completed == 1 )); then
    sentinel_removable=1
    if remove_sentinel_if_removable; then
      return 0
    fi
    echo "rollout completed successfully but automatic sentinel cleanup failed; manual review required before the next rollout" >&2
    exit 1
  fi
  echo "rollout failed status=$status start_attempted=$start_attempted services_started=$services_started; containing services"
  containment_verified=0
  sentinel_removable=0
  if (( stop_attempted == 0 )); then
    # Pure precondition failure — services were never touched, containment
    # was never even attempted. A bare re-invocation behaves identically to
    # the first attempt.
    sentinel_removable=1
  else
    if stop_and_verify_all_services; then
      containment_verified=1
    else
      status=1
      echo "STATE: containment could not be re-proven — rollback skipped, stopped state is genuinely uncertain; sentinel retained" >&2
    fi
    if (( containment_verified == 1 )); then
      if (( start_attempted == 1 )); then
        # Services were already started against the new schema before
        # failing — an automatic DB rollback here could race live writes,
        # so this always requires operator judgment, never an automatic
        # retry. Migrated databases and evidence are preserved as-is.
        echo "STATE: STOPPED_PRESERVED — services stopped after a post-start failure; database is on the NEW schema; no automatic restore attempted; sentinel retained, operator review required" >&2
      elif (( backup_completed == 1 )); then
        # backup_completed is only set after backup_databases() returns
        # successfully for the *whole* cohort — unlike a bare manifest
        # existence/non-empty check, which would already be true the
        # instant the header row is written, before any actual database has
        # been copied. Without this distinction, a failure partway through
        # backup_databases() itself would be misrouted into attempting
        # (and correctly failing) a restore of zero actually-backed-up
        # databases, mislabeling a STOPPED_UNCHANGED state as
        # RESTORE_INCOMPLETE — same sentinel outcome (retained) either way,
        # but the wrong operator-facing recovery instructions.
        if restore_backups; then
          # restore_backups() only returns success once every database's
          # SHA-256 has been independently re-verified against the backup
          # manifest — "restored" and "verified" are the same check here,
          # not two separate steps that could disagree.
          if ! record_phase DATABASES_RESTORED; then
            status=1
            echo "STATE: RESTORE_INCOMPLETE — database restoration completed but its durable recovery phase could not be recorded; manual review required; sentinel retained" >&2
          elif (( release_mode == 1 )) && ! restore_previous_release_and_start; then
            status=1
            echo "STATE: RESTORE_INCOMPLETE — databases restored but previous release pointer/service recovery failed; manual review required; sentinel retained" >&2
          elif ! record_phase FAILED_RESTORED; then
            status=1
            recovery_running=0
            recontain_after_recovery_failure
            echo "STATE: RESTORE_INCOMPLETE — previous release recovery completed but its terminal phase could not be recorded; manual review required; sentinel retained" >&2
          else
            echo "STATE: FAILED_RESTORED — cohort restored and verified; previous release restored and healthy; sentinel will be removed, but this is 'safe to hand to the documented recovery flow,' not 'safe to bare-retry'" >&2
            sentinel_removable=1
          fi
        else
          status=1
          echo "STATE: RESTORE_INCOMPLETE — automatic restore failed or could not be fully verified for every database; manual restoration required; sentinel retained" >&2
        fi
      else
        # No database migration has run. A checkpoint may have changed the
        # SQLite file layout, but the release is still on the old schema and
        # no complete backup is trusted. Recover directly to the previous
        # release before any new service can start; partial backup artifacts
        # are never used as a restore source.
        if (( release_mode == 1 )) && restore_previous_release_and_start && record_phase PRE_BACKUP_RECOVERED; then
          echo "STATE: PRE_BACKUP_RECOVERED — unchanged databases retained; previous release restored and healthy; partial backup artifacts under $backup_set are not trusted" >&2
          sentinel_removable=1
        else
          status=1
          echo "STATE: PRE_BACKUP_RECOVERY_INCOMPLETE — no complete verified cohort backup exists; previous release recovery failed; sentinel retained for manual review" >&2
        fi
      fi
    fi
  fi
  if (( containment_verified == 1 && recovery_running == 0 )); then
    echo "services remain stopped; operator review required"
  elif (( recovery_running == 1 )); then
    echo "previous release services running and recovery health verified"
  fi
  if ! remove_sentinel_if_removable; then
    echo "automatic sentinel cleanup also failed; manual review required in addition to the failure above" >&2
    status=1
  fi
  exit "${status:-1}"
}

# The cleanup trap must be active before the sentinel is ever published, and
# before every later fallible setup operation — otherwise a failure in that
# gap (the artifact_dir collision check right below is the exact case that
# motivated this) would leave behind a sentinel this invocation created
# without on_exit() ever running to auto-remove it via the pure-precondition-
# failure path.
/usr/bin/mkdir -p "$(/usr/bin/dirname "$lock_file")"
exec 9>"$lock_file"
/usr/bin/flock --exclusive --nonblock 9 || die "another rollout is already active"

timestamp="$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)"
if (( test_mode == 1 )) && [[ -n "${AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP:-}" ]]; then
  timestamp="$AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP"
fi
artifact_dir="$log_dir/$timestamp-$expected_commit"
manifest="$artifact_dir/backup-manifest.tsv"
backup_set="$backup_dir/$timestamp-$expected_commit"
sentinel_path="$log_dir/.rollout-in-progress"
phase_ledger="$artifact_dir/phase-ledger.log"

start_attempted=0
services_started=0
recovery_running=0
stop_attempted=0
backup_completed=0
pointer_switched=0
completed=0
sentinel_removable=0
sentinel_identity=""
previous_pointer_target=""
declare -a expected_backups=()

trap on_exit EXIT

# Interrupted-rollout sentinel (Phase 4C.4, issue #135). Checked and, if
# absent, created here — immediately after the lock is acquired and before
# any precondition check runs, including the artifact-directory-uniqueness
# check just below — to close the check-then-act race an earlier draft had:
# a second invocation observing "no sentinel" and only acquiring the lock
# after a third invocation had already failed and left one behind. Lives
# beneath the already-validated canonical, root-owned $log_dir rather than
# a new directory.
if [[ -e "$sentinel_path" || -L "$sentinel_path" ]]; then
  # A sentinel that doesn't look exactly like the ones this helper writes is
  # never trusted or silently overwritten — that's its own containment-
  # uncertain failure, distinct from "a valid sentinel is present."
  [[ ! -L "$sentinel_path" ]] || die "existing rollout sentinel is a symlink, refusing to trust it: $sentinel_path — manual review required"
  [[ -f "$sentinel_path" ]] || die "existing rollout sentinel is not a regular file: $sentinel_path — manual review required"
  sentinel_check_owner="$(/usr/bin/stat -c %u "$sentinel_path")"
  sentinel_check_mode="$(/usr/bin/stat -c %a "$sentinel_path")"
  [[ "$sentinel_check_owner" == "$secure_owner_uid" && "$sentinel_check_mode" == "600" ]] || die "existing rollout sentinel has unsafe ownership or mode: $sentinel_path — manual review required"
  sentinel_prior_commit="$(/usr/bin/sed -n 's/^expected_commit=//p' "$sentinel_path")"
  sentinel_prior_artifact_dir="$(/usr/bin/sed -n 's/^artifact_dir=//p' "$sentinel_path")"
  die "an interrupted rollout sentinel already exists: $sentinel_path (expected_commit=${sentinel_prior_commit:-unknown} artifact_dir=${sentinel_prior_artifact_dir:-unknown}) — review that evidence, then clear it with the separate rollout-sentinel-clear tool before retrying"
fi
sentinel_tmp="$(/usr/bin/mktemp --tmpdir="$log_dir" .rollout-in-progress.XXXXXX)"
{
  printf 'expected_commit=%s\n' "$expected_commit"
  printf 'artifact_dir=%s\n' "$artifact_dir"
  printf 'created_at=%s\n' "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'hostname=%s\n' "$(/usr/bin/hostname)"
  printf 'pid=%s\n' "$$"
  printf 'phase_ledger=%s\n' "$phase_ledger"
} > "$sentinel_tmp"
/usr/bin/chmod 0600 "$sentinel_tmp"
# ln (hard link) is the atomic create-if-not-exists primitive here — it
# fails if the target already exists rather than replacing it, the same
# O_CREAT|O_EXCL semantics called for, without needing a separate syscall
# wrapper.
/usr/bin/ln -- "$sentinel_tmp" "$sentinel_path" || die "failed to atomically create rollout sentinel (unexpected concurrent writer?): $sentinel_path"
/usr/bin/rm -f -- "$sentinel_tmp"
sentinel_identity="$(/usr/bin/stat -c '%d:%i' "$sentinel_path")"

[[ ! -e "$artifact_dir" ]] || die "rollout artifact directory already exists: $artifact_dir"
/usr/bin/mkdir --mode=0700 -- "$artifact_dir"
/usr/bin/chmod 0700 "$artifact_dir"
/usr/bin/cp -a "$systemd_inventory_dir" "$artifact_dir/systemd-inventory"
/usr/bin/sha256sum "$artifact_dir/systemd-inventory/sha256sums" > "$artifact_dir/systemd-inventory.sha256"
touch "$phase_ledger"
chmod 0600 "$phase_ledger"
record_phase PRECHECK_STARTED
log_file="$artifact_dir/rollout.log"
latest_tmp="$(/usr/bin/mktemp --tmpdir="$log_dir" .latest.XXXXXX)"
printf '%s\n' "$artifact_dir" > "$latest_tmp"
/usr/bin/chmod 0600 "$latest_tmp"
/usr/bin/mv -T -- "$latest_tmp" "$log_dir/latest"
exec > >(/usr/bin/tee -a "$log_file") 2>&1

echo "rollout start timestamp=$timestamp expected_commit=$expected_commit"
echo "units=${units[*]}"
echo "database_count=${#databases[@]}"

code_check
if (( release_mode == 1 )); then
  authorization_evidence_sha256=""
  if [[ -n "$authorization_file" ]] && [[ "$deployer_mode" != 1 ]]; then
  "$authorization_validator" --file "$authorization_file" --expected-commit "$expected_commit" "${authorization_identity_args[@]}" --output "$artifact_dir/authorization-evidence.json" || die "rollout authorization validation failed"
    hash_evidence_file "$artifact_dir/authorization-evidence.json"
    authorization_evidence_sha256="$(/usr/bin/sha256sum "$artifact_dir/authorization-evidence.json" | /usr/bin/cut -d' ' -f1)"
  fi
  previous_pointer_target="$pointer_target"
  rollout_helper_sha256="$(/usr/bin/sha256sum "$0" | /usr/bin/cut -d ' ' -f1)"
  {
    printf '{\n  "expectedCommit": "%s",\n  "previousCommit": "%s",\n  "currentPointer": "%s",\n  "releaseRoot": "%s",\n  "releaseDir": "%s",\n  "environment": "%s",\n  "artifactSha256": "%s",\n  "qualificationEvidenceFile": "%s",\n  "qualificationEvidenceSha256": "%s",\n  "rolloutHelperSha256": "%s",\n  "rolloutConfigSha256": "%s",\n  "authorizationValidatorSha256": "%s",\n  "acceptanceValidatorSha256": "%s",\n  "authorizationEvidenceSha256": "%s"\n}\n' \
      "$expected_commit" "$previous_pointer_target" "$current_pointer" "$release_root" "$release_dir" "$environment_identity" "$approved_artifact_sha256" "$qualification_evidence_file" "$approved_evidence_sha256" "$rollout_helper_sha256" "$rollout_config_sha256" "$authorization_validator_sha256" "$acceptance_validator_sha256" "$authorization_evidence_sha256"
  } > "$artifact_dir/release-evidence.json"
  /usr/bin/sha256sum "$artifact_dir/release-evidence.json" > "$artifact_dir/release-evidence.sha256"
  printf '{"activationHelperSha256":"%s"}\n' "$activation_helper_sha256" > "$artifact_dir/activation-helper-evidence.json"
  /usr/bin/sha256sum "$artifact_dir/activation-helper-evidence.json" > "$artifact_dir/activation-helper-evidence.sha256"
  printf '{"releaseStageSha256":"%s","rolloutRestoreSha256":"%s","systemdInventorySha256":"%s"}\n' "$release_stage_sha256" "$rollout_restore_sha256" "$(/usr/bin/sha256sum "$systemd_inventory_dir/sha256sums" | /usr/bin/cut -d' ' -f1)" > "$artifact_dir/trusted-helper-evidence.json"
  /usr/bin/sha256sum "$artifact_dir/trusted-helper-evidence.json" > "$artifact_dir/trusted-helper-evidence.sha256"
fi
[[ -f "$project_dir/scripts/rollout-db.ts" ]] || die "migration helper is missing from expected commit"
[[ -f "$project_dir/node_modules/tsx/dist/cli.mjs" ]] || die "tsx runtime is missing"

db_args=()
build_db_args() {
  db_args=()
  for database in "${databases[@]}"; do db_args+=(--db "$database"); done
  # Per-database resolving-units evidence reuses the unit->canonical-path
  # resolution already proven above rather than re-deriving it in TypeScript.
  for unit in "${!unit_databases[@]}"; do db_args+=(--resolving-unit "${unit_databases[$unit]}=$unit"); done
}
build_db_args
run_db_tool() {
  run_as_runtime "$node_bin" "$project_dir/node_modules/tsx/dist/cli.mjs" "$project_dir/scripts/rollout-db.ts" "$@"
}

declare -A restart_baseline=()
"$systemctl_cmd" reset-failed "${units[@]}"
for unit in "${units[@]}"; do
  assert_service_ready_for_rollout "$unit"
  restart_baseline[$unit]="$("$systemctl_cmd" show "$unit" --property=NRestarts --value)"
  [[ "${restart_baseline[$unit]}" =~ ^[0-9]+$ ]] || die "invalid NRestarts for $unit"
done
run_db_tool inspect --evidence - "${db_args[@]}" > "$artifact_dir/preflight-evidence.json"
hash_evidence_file "$artifact_dir/preflight-evidence.json"
record_phase PREFLIGHT

echo "stopping all services"
stop_attempted=1
stop_and_verify_all_services || die "CONTAINMENT INCOMPLETE during primary stop"
record_phase CONTAINED

code_check
run_db_tool inspect --evidence - "${db_args[@]}" > "$artifact_dir/stopped-evidence.json"
hash_evidence_file "$artifact_dir/stopped-evidence.json"
validate_sqlite_sidecars
echo "draining SQLite WAL sidecars offline"
run_db_tool checkpoint --evidence - "${db_args[@]}" > "$artifact_dir/checkpoint-evidence.json"
hash_evidence_file "$artifact_dir/checkpoint-evidence.json"
clear_stale_sqlite_sidecars
record_phase WAL_DRAINED

echo "backing up all databases"
backup_databases
backup_completed=1
/usr/bin/sha256sum "$manifest" > "$artifact_dir/backup-manifest.sha256"
record_phase BACKED_UP

if [[ -n "$health_relocation_source" ]]; then
  echo "relocating legacy health database source=$health_relocation_source target=$health_relocation_target"
  run_db_tool relocate --from "$health_relocation_source" --to "$health_relocation_target"
  for database_index in "${!databases[@]}"; do
    [[ "${databases[$database_index]}" == "$health_relocation_source" ]] && databases[$database_index]="$health_relocation_target"
  done
  build_db_args
fi

echo "migrating databases using pre-staged commit $expected_commit"
code_check
run_db_tool migrate --evidence - "${db_args[@]}" > "$artifact_dir/migration-evidence.json"
hash_evidence_file "$artifact_dir/migration-evidence.json"
record_phase MIGRATED
echo "reconciling contained lifecycle ownership after schema migration"
run_db_tool reconcile --reason interrupted_by_controlled_rollout --evidence - "${db_args[@]}" > "$artifact_dir/reconciliation-evidence.json"
hash_evidence_file "$artifact_dir/reconciliation-evidence.json"
record_phase LIFECYCLE_RECONCILED
echo "validating migrated databases"
run_db_tool validate --evidence - "${db_args[@]}" > "$artifact_dir/validation-evidence.json"
hash_evidence_file "$artifact_dir/validation-evidence.json"

if (( release_mode == 1 )); then
  echo "activating immutable release commit=$expected_commit previous=$previous_pointer_target"
  "$activation_cmd" --release-root "$release_root" --current "$current_pointer" --expected-commit "$expected_commit"
  [[ "$(/usr/bin/readlink -- "$current_pointer")" == "$expected_commit" ]] || die "active release pointer did not switch to expected commit"
  pointer_switched=1
  printf '{\n  "previousCommit": "%s",\n  "activeCommit": "%s",\n  "pointer": "%s",\n  "transitionAt": "%s"\n}\n' \
    "$previous_pointer_target" "$expected_commit" "$current_pointer" "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$artifact_dir/pointer-switch-evidence.json"
  hash_evidence_file "$artifact_dir/pointer-switch-evidence.json"
  record_phase POINTER_SWITCHED
  install_cleanup_timer
fi

echo "starting all services"
journal_since="$(/usr/bin/date -u '+%Y-%m-%d %H:%M:%S UTC')"
start_attempted=1
record_phase SERVICES_STARTING
restart_boundary="$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')"
"$systemctl_cmd" start "${units[@]}"
for unit in "${units[@]}"; do assert_service_active "$unit"; done
services_started=1
if (( smoke_delay > 0 )); then /usr/bin/sleep "$smoke_delay"; fi
journal_args=()
for unit in "${units[@]}"; do journal_args+=(-u "$unit"); done
startup_errors="$("$journalctl_cmd" --since "$journal_since" --priority err --no-pager "${journal_args[@]}" 2>&1)" || die "journal smoke command failed"
[[ -z "$startup_errors" || "$startup_errors" == "-- No entries --" ]] || die "startup journal smoke found errors: $startup_errors"
for unit in "${units[@]}"; do
  assert_service_active "$unit"
  current_restarts="$("$systemctl_cmd" show "$unit" --property=NRestarts --value)"
  [[ "$current_restarts" =~ ^[0-9]+$ && "$current_restarts" == "${restart_baseline[$unit]}" ]] || die "service restarted or crash-looped during smoke: $unit"
done
run_db_tool validate --restart-boundary "$restart_boundary" --evidence - "${db_args[@]}" > "$artifact_dir/post-start-evidence.json"
hash_evidence_file "$artifact_dir/post-start-evidence.json"
acceptance_args=(--before "$artifact_dir/preflight-evidence.json" --after "$artifact_dir/post-start-evidence.json" --reconciliation-evidence "$artifact_dir/reconciliation-evidence.json" --output "$artifact_dir/acceptance-evidence.json")
if [[ -n "$health_relocation_source" ]]; then
  acceptance_args+=(--relocated-from "$health_relocation_source" --relocated-to "$health_relocation_target")
fi
"$acceptance_validator" "${acceptance_args[@]}" || die "bounded queue/claim/lock acceptance failed"
hash_evidence_file "$artifact_dir/acceptance-evidence.json"
if [[ -n "$health_relocation_source" ]]; then
  echo "retiring legacy health database path=$health_relocation_source"
  /usr/bin/rm -f -- "$health_relocation_source" "${health_relocation_source}-wal" "${health_relocation_source}-shm"
  [[ ! -e "$health_relocation_source" && ! -L "$health_relocation_source" ]] || die "legacy health database could not be retired"
  record_phase HEALTH_DB_RELOCATED
fi
record_phase ACCEPTED

completed=1
record_phase COMPLETE
printf '{"status":"complete","targetCommit":"%s","artifactSha256":"%s","environment":"%s","approvalReference":"%s","artifactDir":"%s","completedAt":"%s"}\n' "$expected_commit" "$deployer_artifact_sha256" "$deployer_environment" "$deployer_approval_reference" "$artifact_dir" "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$artifact_dir/deployment-result.json"
/usr/bin/sha256sum "$artifact_dir/deployment-result.json" > "$artifact_dir/deployment-result.sha256"
echo "rollout completed commit=$expected_commit artifacts=$artifact_dir"
