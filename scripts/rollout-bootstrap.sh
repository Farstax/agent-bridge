#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Guarded bootstrap helper for genuinely missing production databases
# (Phase 4C.3, issue #135). Install root-owned at:
#   /usr/local/sbin/rollout-bootstrap-agent-bridge
# with its own root-owned inventory at:
#   /etc/agent-bridge/rollout-bootstrap.conf
#
# Separate, explicitly-invoked route from rollout-agent-bridge.sh's ordinary
# --expected-commit migrate flow — never invoked implicitly by inspect/
# migrate/validate, and never bundled into the same invocation as a
# migration of existing databases (no pre-migration backup exists for a
# database that didn't exist, so it cannot participate in the whole-cohort
# restore guarantee the same way). Reuses openDb()'s existing, already-
# tested missing-file -> full-migration-plan path at the database layer
# (scripts/rollout-db.ts bootstrap); this script owns only the operator-
# facing guardrails: a fixed allowlist of expected new-role paths, parent-
# directory ownership/permission validation matching the existing backup-
# directory discipline, and coordination with the main rollout lock so a
# bootstrap can never race an active migrate rollout.

die() {
  echo "rollout-bootstrap: $*" >&2
  exit 1
}

readonly -a ALLOWED_ROLES=(shared discord health interactive)
is_allowed_role() {
  local candidate="$1" allowed
  for allowed in "${ALLOWED_ROLES[@]}"; do [[ "$candidate" == "$allowed" ]] && return 0; done
  return 1
}

new_role=""
new_role_path=""
if [[ "${1:-}" == "--role" && -n "${2:-}" && "${3:-}" == "--new-role" && -n "${4:-}" \
      && "${5:-}" == "--confirm-new-role" && -n "${6:-}" && $# -eq 6 ]]; then
  new_role="$2"
  new_role_path="$4"
  [[ "$6" == "$new_role_path" ]] || die "--confirm-new-role must exactly match --new-role (expected \"$new_role_path\", got \"$6\")"
else
  die "usage: rollout-bootstrap --role <shared|discord|health|interactive> --new-role <absolute path> --confirm-new-role <same absolute path>"
fi
is_allowed_role "$new_role" || die "unknown database role: $new_role"
[[ "$new_role_path" == /* ]] || die "new-role path must be absolute"

test_root="${AGENT_BRIDGE_ROLLOUT_TEST_ROOT:-}"
if [[ -n "$test_root" ]]; then
  (( EUID != 0 )) || die "test root is forbidden during root execution"
  [[ "$test_root" == /* && -d "$test_root" ]] || die "invalid test root"
  config_file="$test_root/etc/agent-bridge/rollout-bootstrap.conf"
  lock_file="$test_root/run/lock/agent-bridge-rollout.lock"
  runuser_cmd="$test_root/bin/runuser"
  id_cmd="$test_root/bin/id"
  test_mode=1
else
  (( EUID == 0 )) || die "must run as root"
  config_file="/etc/agent-bridge/rollout-bootstrap.conf"
  lock_file="/run/lock/agent-bridge-rollout.lock"
  runuser_cmd="/usr/sbin/runuser"
  id_cmd="/usr/bin/id"
  test_mode=0
fi

for command_path in "$runuser_cmd" "$id_cmd" /usr/bin/flock /usr/bin/realpath /usr/bin/stat /usr/bin/mkdir /usr/bin/dirname; do
  [[ -x "$command_path" ]] || die "required command is unavailable: $command_path"
done

[[ -f "$config_file" && ! -L "$config_file" ]] || die "missing fixed bootstrap config: $config_file"
if (( test_mode == 0 )); then
  [[ "$(/usr/bin/stat -c %U "$config_file")" == "root" ]] || die "bootstrap config must be owned by root"
  config_mode="$(/usr/bin/stat -c %a "$config_file")"
  (( (8#$config_mode & 022) == 0 )) || die "bootstrap config must not be group/world writable"
fi

project_dir=""
runtime_user=""
node_bin=""
declare -A bootstrap_roles=()
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ -n "$value" ]] || die "empty bootstrap config value for $key"
  case "$key" in
    project_dir) [[ -z "$project_dir" ]] || die "duplicate project_dir"; project_dir="$value" ;;
    runtime_user) [[ -z "$runtime_user" ]] || die "duplicate runtime_user"; runtime_user="$value" ;;
    node_bin) [[ -z "$node_bin" ]] || die "duplicate node_bin"; node_bin="$value" ;;
    bootstrap_role)
      [[ "$value" == *:/* ]] || die "bootstrap_role must be role:absolute-path, got: $value"
      role_name="${value%%:*}"
      role_path="${value#*:}"
      is_allowed_role "$role_name" || die "unknown role in bootstrap_role entry: $role_name"
      [[ -z "${bootstrap_roles[$role_name]:-}" ]] || die "duplicate bootstrap_role entry for role: $role_name"
      bootstrap_roles[$role_name]="$role_path"
      ;;
    *) die "unknown bootstrap config key: $key" ;;
  esac
done < "$config_file"

for value_name in project_dir runtime_user node_bin; do
  [[ -n "${!value_name}" ]] || die "missing bootstrap config key: $value_name"
done
(( ${#bootstrap_roles[@]} > 0 )) || die "no bootstrap_role entries configured — new roles must be explicitly allowlisted"
[[ "$project_dir" == /* && "$node_bin" == /* ]] || die "configured paths must be absolute"
[[ -d "$project_dir" && ! -L "$project_dir" ]] || die "project directory is missing or symlinked"
[[ "$(/usr/bin/realpath -e "$project_dir")" == "$project_dir" ]] || die "project directory is not canonical"
[[ -x "$node_bin" && ! -L "$node_bin" ]] || die "configured Node binary is missing or symlinked"
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "invalid runtime user"
if (( test_mode == 0 )); then /usr/bin/id -u "$runtime_user" >/dev/null || die "runtime user does not exist"; fi

[[ -n "${bootstrap_roles[$new_role]:-}" ]] || die "requested role is not in the fixed bootstrap allowlist: $new_role"
[[ "${bootstrap_roles[$new_role]}" == "$new_role_path" ]] || die "requested role/path pair is not in the fixed bootstrap allowlist: $new_role:$new_role_path"

# Deliberately no destination-existence check here, before the lock: a
# SIGKILL or reboot between rollout-db.ts's atomic link() publish and its
# own temp-name unlink() can leave the destination genuinely, validly
# published *and* a stale extra hard link at the old temp name — recovering
# from that must run under the same exclusive lock every other bootstrap
# state check runs under, not before it. rollout-db.ts's own bootstrap mode
# performs that inode-verified recovery first, then still refuses with
# "already exists" if the destination turns out to be a real, already-
# completed database rather than debris.
parent_dir="$(/usr/bin/dirname "$new_role_path")"
[[ -d "$parent_dir" && ! -L "$parent_dir" ]] || die "new-role parent directory is missing or symlinked: $parent_dir"
[[ "$(/usr/bin/realpath -e "$parent_dir")" == "$parent_dir" ]] || die "new-role parent directory is not canonical: $parent_dir"
# The parent directory must be owned by the *runtime user*, not root: this
# script drops to the runtime user (run_as_runtime, below) before the
# database is ever created there, exactly like every other production
# database directory (they're written day-to-day by the services running as
# that same user). Requiring root ownership here would be self-contradictory
# — root would pass this check but the runtime user actually doing the write
# would then get a permission error, or worse, the check would only pass if
# the directory were writable by both, widening its permissions unnecessarily.
runtime_uid="$("$id_cmd" -u "$runtime_user")"
[[ "$runtime_uid" =~ ^[0-9]+$ ]] || die "cannot resolve UID for runtime user: $runtime_user"
[[ "$(/usr/bin/stat -c %u "$parent_dir")" == "$runtime_uid" ]] || die "new-role parent directory must be owned by the runtime user ($runtime_user): $parent_dir"
parent_mode="$(/usr/bin/stat -c %a "$parent_dir")"
(( (8#$parent_mode & 022) == 0 )) || die "new-role parent directory must not be group/world writable: $parent_dir"

# Same lock file as rollout-agent-bridge.sh: a bootstrap and an ordinary
# migrate rollout must never run concurrently, even though bootstrap is a
# structurally separate invocation.
/usr/bin/mkdir -p "$(/usr/bin/dirname "$lock_file")"
exec 9>"$lock_file"
/usr/bin/flock --exclusive --nonblock 9 || die "a rollout or bootstrap is already active"

[[ -f "$project_dir/scripts/rollout-db.ts" ]] || die "bootstrap helper is missing from expected project checkout"
[[ -f "$project_dir/node_modules/tsx/dist/cli.mjs" ]] || die "tsx runtime is missing"

run_as_runtime() {
  "$runuser_cmd" --user "$runtime_user" -- "$@"
}

echo "bootstrapping new-role database: role=$new_role path=$new_role_path"
run_as_runtime "$node_bin" "$project_dir/node_modules/tsx/dist/cli.mjs" "$project_dir/scripts/rollout-db.ts" bootstrap \
  --db "$new_role_path" --role "$new_role" --confirm-new-role "$new_role_path"
echo "bootstrap completed: $new_role_path"
