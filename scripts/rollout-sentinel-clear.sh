#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Guarded manual clearing tool for the interrupted-rollout sentinel
# (Phase 4C.4, issue #135). Install root-owned at:
#   /usr/local/sbin/rollout-sentinel-clear
# Reads the same root-owned inventory as rollout-agent-bridge.sh:
#   /etc/agent-bridge/rollout.conf
#
# Clearing the sentinel is never a bare `rm`. This tool acquires the exact
# same exclusive rollout lock rollout-agent-bridge.sh uses, before reading
# or deleting anything — if the lock cannot be acquired (a rollout is
# genuinely in progress), it aborts immediately and leaves the sentinel
# completely untouched, never falling back to an unguarded read or delete.
# Only once the lock is held does it re-validate the sentinel's ownership/
# mode/non-symlink status and cross-check its recorded expected_commit and
# artifact_dir against what the operator supplies on the command line —
# proving the operator has actually reviewed the evidence for *this*
# sentinel, not a stale one from an unrelated earlier attempt — before
# logging the action and removing it.

die() {
  echo "rollout-sentinel-clear: $*" >&2
  exit 1
}

confirm_commit=""
confirm_artifact_dir=""
if [[ "${1:-}" == "--expected-commit" && -n "${2:-}" && "${3:-}" == "--artifact-dir" && -n "${4:-}" && $# -eq 4 ]]; then
  confirm_commit="$2"
  confirm_artifact_dir="$4"
else
  die "usage: rollout-sentinel-clear --expected-commit <40-character SHA> --artifact-dir <absolute path>"
fi
[[ "$confirm_commit" =~ ^[0-9a-f]{40}$ ]] || die "expected commit must be a full 40-character lowercase SHA"
[[ "$confirm_artifact_dir" == /* ]] || die "artifact-dir must be an absolute path"

test_root="${AGENT_BRIDGE_ROLLOUT_TEST_ROOT:-}"
if [[ -n "$test_root" ]]; then
  (( EUID != 0 )) || die "test root is forbidden during root execution"
  [[ "$test_root" == /* && -d "$test_root" ]] || die "invalid test root"
  config_file="$test_root/etc/agent-bridge/rollout.conf"
  lock_file="$test_root/run/lock/agent-bridge-rollout.lock"
  test_mode=1
else
  (( EUID == 0 )) || die "must run as root"
  config_file="/etc/agent-bridge/rollout.conf"
  lock_file="/run/lock/agent-bridge-rollout.lock"
  test_mode=0
fi

for command_path in /usr/bin/flock /usr/bin/realpath /usr/bin/stat /usr/bin/mkdir /usr/bin/rm /usr/bin/date /usr/bin/hostname /usr/bin/sed /usr/bin/chmod /usr/bin/dirname /usr/bin/ln /usr/bin/mktemp /usr/bin/sleep; do
  [[ -x "$command_path" ]] || die "required command is unavailable: $command_path"
done
[[ -f "$config_file" && ! -L "$config_file" ]] || die "missing fixed rollout config: $config_file"
if (( test_mode == 0 )); then
  [[ "$(/usr/bin/stat -c %U "$config_file")" == "root" ]] || die "rollout config must be owned by root"
  config_mode="$(/usr/bin/stat -c %a "$config_file")"
  (( (8#$config_mode & 022) == 0 )) || die "rollout config must not be group/world writable"
fi

# Reads the same config file rollout-agent-bridge.sh uses, but only cares
# about log_dir — every other key (project_dir, runtime_user, etc.) is
# read and silently ignored rather than rejected, since this is the same
# shared, authoritative config file that script also depends on.
log_dir=""
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ -n "$value" ]] || continue
  if [[ "$key" == log_dir ]]; then
    [[ -z "$log_dir" ]] || die "duplicate log_dir in $config_file"
    log_dir="$value"
  fi
done < "$config_file"
[[ -n "$log_dir" ]] || die "missing rollout config key: log_dir"
[[ "$log_dir" == /* ]] || die "log_dir must be absolute"

secure_owner_uid="$EUID"
if (( test_mode == 0 )); then secure_owner_uid=0; fi
[[ -d "$log_dir" && ! -L "$log_dir" ]] || die "log_dir is missing or symlinked: $log_dir"
[[ "$(/usr/bin/realpath -e "$log_dir")" == "$log_dir" ]] || die "log_dir is not canonical: $log_dir"
[[ "$(/usr/bin/stat -c %u "$log_dir")" == "$secure_owner_uid" ]] || die "log_dir has unsafe ownership: $log_dir"
log_dir_mode="$(/usr/bin/stat -c %a "$log_dir")"
(( (8#$log_dir_mode & 022) == 0 )) || die "log_dir must not be group/world writable: $log_dir"

sentinel_path="$log_dir/.rollout-in-progress"

/usr/bin/mkdir -p "$(/usr/bin/dirname "$lock_file")"
exec 9>"$lock_file"
# The structural guarantee: this can never run concurrently with an active
# rollout. If the lock is held elsewhere, abort here — before the sentinel
# has been read, inspected, or touched in any way.
/usr/bin/flock --exclusive --nonblock 9 || die "a rollout is currently active — refusing to touch the sentinel while it may still be in use"

# Test-only synchronization: acknowledge the acquired real lock and hold it
# until the test closes stdin. No competing probe or fixed sleep window.
if (( test_mode == 1 )) && [[ "${AGENT_BRIDGE_ROLLOUT_TEST_HOLD_LOCK:-}" == 1 ]]; then
  printf '%s\n' TEST_LOCK_ACQUIRED
  read -r || :
fi

if [[ ! -e "$sentinel_path" && ! -L "$sentinel_path" ]]; then
  echo "rollout-sentinel-clear: no sentinel present at $sentinel_path — nothing to clear"
  exit 0
fi
[[ ! -L "$sentinel_path" ]] || die "sentinel is a symlink, refusing to trust or remove it: $sentinel_path"
[[ -f "$sentinel_path" ]] || die "sentinel is not a regular file, refusing to trust or remove it: $sentinel_path"
sentinel_owner="$(/usr/bin/stat -c %u "$sentinel_path")"
sentinel_mode="$(/usr/bin/stat -c %a "$sentinel_path")"
[[ "$sentinel_owner" == "$secure_owner_uid" && "$sentinel_mode" == "600" ]] || die "sentinel has unsafe ownership or mode, refusing to trust or remove it: $sentinel_path"

sentinel_commit="$(/usr/bin/sed -n 's/^expected_commit=//p' "$sentinel_path")"
sentinel_artifact_dir="$(/usr/bin/sed -n 's/^artifact_dir=//p' "$sentinel_path")"
[[ -n "$sentinel_commit" && -n "$sentinel_artifact_dir" ]] || die "sentinel is missing required fields, refusing to trust or remove it: $sentinel_path"
# The operator must supply the exact values recorded in the sentinel they
# actually reviewed — this is what stops a stale sentinel from an
# unrelated earlier attempt from being mistaken for the current one.
[[ "$sentinel_commit" == "$confirm_commit" ]] || die "provided --expected-commit does not match the sentinel's recorded value ($sentinel_commit) — re-review the evidence before retrying"
[[ "$sentinel_artifact_dir" == "$confirm_artifact_dir" ]] || die "provided --artifact-dir does not match the sentinel's recorded value ($sentinel_artifact_dir) — re-review the evidence before retrying"

# The audit log itself gets the same non-symlink discipline as the sentinel
# it records — a root process must never write or chmod through an
# attacker-planted symlink at this path.
audit_log="$log_dir/sentinel-clear.log"
if [[ -e "$audit_log" || -L "$audit_log" ]]; then
  [[ ! -L "$audit_log" ]] || die "sentinel-clear audit log is a symlink, refusing to write through it: $audit_log — manual review required"
  [[ -f "$audit_log" ]] || die "sentinel-clear audit log is not a regular file, refusing to write to it: $audit_log — manual review required"
  [[ "$(/usr/bin/stat -c %u "$audit_log")" == "$secure_owner_uid" ]] || die "sentinel-clear audit log has unsafe ownership: $audit_log — manual review required"
else
  audit_tmp="$(/usr/bin/mktemp --tmpdir="$log_dir" .sentinel-clear-log.XXXXXX)"
  /usr/bin/chmod 0600 "$audit_tmp"
  /usr/bin/ln -- "$audit_tmp" "$audit_log" 2>/dev/null || true
  /usr/bin/rm -f -- "$audit_tmp"
  [[ -f "$audit_log" && ! -L "$audit_log" ]] || die "failed to safely create sentinel-clear audit log: $audit_log"
fi
/usr/bin/chmod 0600 "$audit_log"

# This pre-delete entry is the authoritative record that removal was
# reviewed and authorized for exactly this sentinel — it must be written
# successfully (a required, fallible step) before the sentinel is touched.
printf '%s hostname=%s pid=%s action=clear_authorized expected_commit=%s artifact_dir=%s\n' \
  "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(/usr/bin/hostname)" "$$" "$sentinel_commit" "$sentinel_artifact_dir" >> "$audit_log"

# Sentinel removal, verified by its subsequent absence, is the commit point
# for this tool: the last required, fallible operation. Nothing after this
# may turn an already-committed clear into an ambiguous nonzero result —
# an operator must be able to trust that "sentinel gone" and "exit 0" agree.
sentinel_removed=0
if (( test_mode == 1 )) && [[ -n "${AGENT_BRIDGE_ROLLOUT_TEST_FORCE_SENTINEL_RM_FAILURE:-}" ]]; then
  : # test-only seam: simulate a removal failure without touching the file
else
  /usr/bin/rm -f -- "$sentinel_path" && sentinel_removed=1
fi
(( sentinel_removed == 1 )) || die "failed to remove sentinel: $sentinel_path — audit shows an authorized attempt only, sentinel may still be present, manual review required"
[[ ! -e "$sentinel_path" && ! -L "$sentinel_path" ]] || die "sentinel still present after removal attempt: $sentinel_path — manual review required"

# The sentinel is gone and verified absent — the clear has committed. From
# here on nothing is allowed to change the tool's result: every remaining
# step (the confirmation echo, the optional completion audit entry, its own
# warning on failure) is purely informational. `set +e` makes this region
# genuinely non-failing rather than merely "individually guarded" — a
# closed/broken stdout on the confirmation echo, or a failed warning echo
# after a failed completion-audit write, must not make an already-committed
# clear exit nonzero.
set +e
echo "rollout-sentinel-clear: sentinel cleared (expected_commit=$sentinel_commit artifact_dir=$sentinel_artifact_dir)"
completion_audit_log="$audit_log"
if (( test_mode == 1 )) && [[ -n "${AGENT_BRIDGE_ROLLOUT_TEST_FORCE_COMPLETION_AUDIT_FAILURE:-}" ]]; then
  completion_audit_log="$log_dir/does-not-exist/sentinel-clear.log"
fi
printf '%s hostname=%s pid=%s action=clear_completed expected_commit=%s artifact_dir=%s\n' \
  "$(/usr/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(/usr/bin/hostname)" "$$" "$sentinel_commit" "$sentinel_artifact_dir" >> "$completion_audit_log" 2>/dev/null
if (( $? != 0 )); then
  echo "rollout-sentinel-clear: warning: failed to append the optional clear_completed audit entry (sentinel was already removed and verified successfully)" >&2
fi
exit 0
