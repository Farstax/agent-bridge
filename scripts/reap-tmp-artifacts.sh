#!/usr/bin/env bash
# Idempotent janitor for temporary artifacts that agent-bridge and its bots
# leave behind when a run/session/test is interrupted instead of reaching its
# own cleanup code (crash, kill, timeout, Ctrl-C). Safe to run repeatedly:
# every file/dir it removes is either uniquely named (no in-flight run will
# ever reuse the name) or an already-merged, uncommitted-change-free git
# worktree.
set -uo pipefail

TMP_ROOT="${REAP_TMP_ROOT:-/tmp}"
MAX_AGE_HOURS="${REAP_MAX_AGE_HOURS:-24}"
MAX_AGE_MIN=$(( MAX_AGE_HOURS * 60 ))
DRY_RUN=0
FAILURES=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

if [[ ! "$MAX_AGE_HOURS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[reap-tmp-artifacts] REAP_MAX_AGE_HOURS must be a positive integer" >&2
  exit 2
fi

log() { echo "[reap-tmp-artifacts] $*"; }

# The daily cleanup timer is the existing bounded service lifecycle for host
# housekeeping.  It may prune only the configured interactive database and
# only through rollout-db's terminal-run ACP predicate.  A missing or unsafe
# path is a no-op: cleanup must never discover databases by scanning disk.
prune_acp_telemetry() {
  local database="${BRIDGE_DB_PATH:-}" release node_bin
  [[ -n "$database" ]] || { log "ACP telemetry retention skipped: BRIDGE_DB_PATH is unset"; return 0; }
  [[ "$database" == /* && -f "$database" && ! -L "$database" ]] || { log "ACP telemetry retention skipped: database path is unsafe"; return 0; }
  release="${BRIDGE_CURRENT_RELEASE_DIR:-}"
  [[ -L "$release" ]] || { log "ACP telemetry retention skipped: active release pointer is unavailable"; return 0; }
  release="$(realpath -e "$release")" || return 1
  node_bin="${NODE_BIN:-node}"
  command -v "$node_bin" >/dev/null 2>&1 || { log "ACP telemetry retention skipped: node is unavailable"; return 0; }
  [[ -f "$release/node_modules/tsx/dist/cli.mjs" && -f "$release/scripts/rollout-db.ts" ]] || { log "ACP telemetry retention skipped: active retention tooling is unavailable"; return 0; }
  local prune_error
  if prune_error="$("$node_bin" "$release/node_modules/tsx/dist/cli.mjs" "$release/scripts/rollout-db.ts" prune --db "$database" 2>&1 >/dev/null)"; then
    return 0
  fi
  # The live bridge may hold the write lock. Committed batches stay deleted;
  # the remainder is retried by the next daily run.
  if [[ "$prune_error" == *SQLITE_BUSY* || "$prune_error" == *"database is locked"* ]]; then
    log "ACP telemetry retention deferred: configured database is busy"
    return 0
  fi
  printf '%s\n' "$prune_error" >&2
  log "ACP telemetry retention failed for configured database" >&2
  FAILURES=$((FAILURES + 1))
}

remove_entry() {
  local entry="$1" reason="$2" rm_error="" sudo_error=""
  if (( DRY_RUN )); then
    log "would remove ($reason): $entry"
    return 0
  fi

  log "removing ($reason): $entry"
  if rm_error="$(rm -rf -- "$entry" 2>&1)"; then
    return 0
  fi

  # Keep privileged cleanup bounded to the exact entry that already passed
  # the janitor's path/age/ownership checks. The runtime account is required
  # by the host-administration contract to have non-interactive admin sudo.
  if command -v sudo >/dev/null 2>&1; then
    if sudo_error="$(sudo -n /usr/bin/rm -rf -- "$entry" 2>&1)"; then
      log "removed with administrative fallback: $entry"
      return 0
    fi
  fi

  [[ -n "$rm_error" ]] && printf '%s\n' "$rm_error" >&2
  [[ -n "$sudo_error" ]] && printf '%s\n' "$sudo_error" >&2
  log "failed to remove eligible artifact: $entry" >&2
  FAILURES=$((FAILURES + 1))
  return 0
}

has_live_pid_marker() {
  local entry="$1" marker pid
  while IFS= read -r -d '' marker; do
    pid="$(tr -cd '0-9' < "$marker" 2>/dev/null || true)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  done < <(find "$entry" -maxdepth 2 -type f \( -name .pid -o -name '*.pid' -o -name .lease -o -name '*.lease' \) -print0 2>/dev/null)
  return 1
}

has_open_file_owner() {
  local entry="$1"
  command -v fuser >/dev/null 2>&1 && fuser -s -- "$entry" 2>/dev/null
}

has_ownership_signal() {
  local entry="$1"
  if has_live_pid_marker "$entry" || has_open_file_owner "$entry"; then
    log "preserving (ownership signal): $entry"
    return 0
  fi
  return 1
}


# Only explicit checkouts or detached worktrees registered to a known OSS repo.
# Never discover candidates by walking home directories.
checkout_has_active_process() {
  local checkout="$1" proc ref owner target current_uid
  current_uid="$(id -u)"
  for proc in /proc/[0-9]*; do
    [[ -r "$proc/status" ]] || continue
    owner="$(sed -n 's/^Uid:[[:space:]]*\([0-9]*\).*/\1/p' "$proc/status" | head -n 1)"
    [[ "$owner" == "$current_uid" ]] || continue
    local command_line
    command_line="$(tr '\000' ' ' < "$proc/cmdline" 2>/dev/null || true)"
    [[ "$command_line" == *"$checkout"* ]] && return 0
    for ref in "$proc/cwd" "$proc/exe" "$proc"/fd/*; do
      [[ -L "$ref" ]] || continue
      target="$(readlink -- "$ref" 2>/dev/null || true)"
      if [[ "$target" == "$checkout" || "$target" == "$checkout/"* ]]; then
        return 0
      fi
    done
  done
  return 1
}

reap_detached_checkout_dependencies() {
  local checkout="$1" root origin status dependencies age now
  [[ "$checkout" == /* && -d "$checkout" && ! -L "$checkout" ]] || return 0
  [[ "$(realpath -e -- "$checkout" 2>/dev/null)" == "$checkout" ]] || return 0
  [[ "$(stat -c %u -- "$checkout" 2>/dev/null)" == "$(id -u)" ]] || return 0
  [[ -e "$checkout/.git" ]] || return 0
  root="$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null)" || return 0
  [[ "$root" == "$checkout" ]] || return 0
  # Accept only the actual Farstax OSS repository, not a similarly named tree.
  origin="$(git -C "$checkout" remote get-url origin 2>/dev/null)" || return 0
  case "$origin" in
    https://github.com/Farstax/agent-bridge|https://github.com/Farstax/agent-bridge.git|git@github.com:Farstax/agent-bridge.git) ;;
    *) log "preserving (unverified OSS origin): $checkout"; return 0 ;;
  esac
  [[ -z "$(git -C "$checkout" symbolic-ref -q HEAD 2>/dev/null)" ]] || return 0
  status="$(git -C "$checkout" status --porcelain=v1 --untracked-files=all 2>/dev/null)" || return 0
  [[ -z "$status" ]] || { log "preserving (dirty checkout): $checkout"; return 0; }
  git -C "$checkout" merge-base --is-ancestor HEAD refs/remotes/origin/main 2>/dev/null || {
    log "preserving (unverified detached commit): $checkout"
    return 0
  }
  dependencies="$checkout/node_modules"
  [[ -d "$dependencies" && ! -L "$dependencies" ]] || return 0
  [[ "$(stat -c %u -- "$dependencies" 2>/dev/null)" == "$(id -u)" ]] || return 0
  now="$(date +%s)"
  age="$(stat -c %Y -- "$dependencies" 2>/dev/null)" || return 0
  (( now - age > MAX_AGE_MIN * 60 )) || return 0
  # A recently written nested package makes a stale directory mtime misleading.
  # Any unreadable subtree or recent write means ownership cannot be proved.
  local recently_changed
  recently_changed="$(find "$dependencies" -xdev -mmin "-$MAX_AGE_MIN" -print -quit 2>/dev/null)" || {
    log "preserving (dependency activity unverified): $checkout"
    return 0
  }
  [[ -z "$recently_changed" ]] || {
    log "preserving (recent dependency writes): $checkout"
    return 0
  }
  if has_ownership_signal "$checkout" || checkout_has_active_process "$checkout"; then
    log "preserving (active checkout): $checkout"
    return 0
  fi
  remove_entry "$dependencies" "inactive clean detached OSS dependencies"
}

# Age-sweep every direct child of $dir matching an optional -name glob.
# Safe because every name here embeds a UUID/PID/random suffix — nothing
# still running will ever look for an old name again.
sweep_by_age() {
  local dir="$1" name_glob="${2:-}"
  [[ -d "$dir" ]] || return 0
  local find_args=("$dir" -maxdepth 1 -mindepth 1 -mmin "+${MAX_AGE_MIN}")
  [[ -n "$name_glob" ]] && find_args+=(-name "$name_glob")
  while IFS= read -r -d '' entry; do
    has_ownership_signal "$entry" && continue
    remove_entry "$entry" "age > ${MAX_AGE_HOURS}h"
  done < <(find "${find_args[@]}" -print0 2>/dev/null)
}

# /tmp/agent-bridge-* mixes throwaway test/mkdtemp fixtures with real git
# worktree clones (PR rebase/verification checkouts). Only the former are
# safe to age-sweep; anything containing a .git is routed to
# reap_worktree_repo below instead, which applies the merged+clean check.
sweep_agent_bridge_scratch() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local entry
  for entry in "$dir"/agent-bridge-*; do
    [[ -e "$entry" ]] || continue
    if [[ -d "$entry" && -e "$entry/.git" ]]; then
      continue
    fi
    local mtime now age
    mtime=$(stat -c %Y "$entry" 2>/dev/null || echo 0)
    now=$(date +%s)
    age=$(( (now - mtime) / 60 ))
    if (( age > MAX_AGE_MIN )); then
      has_ownership_signal "$entry" && continue
      remove_entry "$entry" "age > ${MAX_AGE_HOURS}h"
    fi
  done
}

# Remove worktrees of $repo whose branch is already merged into the repo's
# default branch AND have no uncommitted changes (staged or unstaged).
# Anything dirty, unmerged, or detached HEAD is left untouched — those may
# be in-progress work and only a human (or the finishing-a-development-branch
# skill) should remove them.
reap_worktree_repo() {
  local repo="$1"
  [[ -e "$repo/.git" ]] || return 0

  local default_branch
  default_branch="$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  default_branch="${default_branch:-main}"

  local wt="" branch=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt="${line#worktree }" ;;
      "branch "*)
        branch="${line#branch }"
        branch="${branch#refs/heads/}"
        ;;
      "detached")
        if [[ -n "$wt" && "$wt" != "$repo" ]]; then
          reap_detached_checkout_dependencies "$wt"
        fi
        wt=""
        branch=""
        ;;
      "")
        if [[ -n "$wt" && -n "$branch" && "$wt" != "$repo" ]]; then
          if [[ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ]]; then
            if git -C "$repo" merge-base --is-ancestor "$branch" "$default_branch" 2>/dev/null; then
          if has_ownership_signal "$wt"; then
            :
          elif (( DRY_RUN )); then
            log "would remove worktree (merged+clean): $wt [$branch]"
          else
            log "removing worktree (merged+clean): $wt [$branch]"
            git -C "$repo" worktree remove "$wt" 2>/dev/null \
              && git -C "$repo" branch -d "$branch" 2>/dev/null
              fi
            fi
          fi
        fi
        wt=""
        branch=""
        ;;
    esac
  done < <(git -C "$repo" worktree list --porcelain; echo)
}


# Capacity is observed at the same chosen filesystem before and after cleanup.
# Concurrent writers may change the counters; report observed free-space change,
# not a claim that every extra free byte came from this janitor.
REPORT_ROOT="${REAP_REPORT_ROOT:-${TMP_ROOT}}"
[[ -d "$REPORT_ROOT" && ! -L "$REPORT_ROOT" ]] || REPORT_ROOT="/"
read_capacity() {
  df -P -B1 -- "$REPORT_ROOT" 2>/dev/null | awk 'NR == 2 { print $4 }'
}
read_inodes() {
  df -P -i -- "$REPORT_ROOT" 2>/dev/null | awk 'NR == 2 { print $4 }'
}
capacity_before="$(read_capacity)"
inodes_before="$(read_inodes)"

sweep_by_age "${TMP_ROOT}/bridge-out"
sweep_by_age "${TMP_ROOT}" "bridge-uploads-*"
sweep_by_age "${TMP_ROOT}" "antigravity-*.log"
sweep_by_age "${TMP_ROOT}" "agent-bridge-advisor-*.sock"
sweep_by_age "${TMP_ROOT}/agent-bridge-voice" "voice-*"
sweep_agent_bridge_scratch "${TMP_ROOT}"

prune_acp_telemetry

IFS=',' read -r -a REPOS <<< "${REAP_WORKTREE_REPOS:-${HOME:-}/agent-bridge}"
for repo in "${REPOS[@]}"; do
  [[ -n "$repo" ]] && reap_worktree_repo "$repo"
done

# Optional exact detached-checkout inventory, for standalone detached clones
# that are not linked Git worktrees. All candidates receive the same checks.
IFS=',' read -r -a DETACHED_CHECKOUTS <<< "${REAP_DETACHED_CHECKOUTS:-}"
for checkout in "${DETACHED_CHECKOUTS[@]}"; do
  [[ -n "$checkout" ]] && reap_detached_checkout_dependencies "$checkout"
done


capacity_after="$(read_capacity)"
inodes_after="$(read_inodes)"
if [[ "$capacity_before" =~ ^[0-9]+$ && "$capacity_after" =~ ^[0-9]+$ && "$inodes_after" =~ ^[0-9]+$ ]]; then
  gain=$(( capacity_after > capacity_before ? capacity_after - capacity_before : 0 ))
  log "disk_headroom root=$REPORT_ROOT free_bytes=$capacity_after observed_recovered_bytes=$gain free_inodes=$inodes_after before_free_inodes=$inodes_before"
  required="${REAP_REQUIRED_HEADROOM_BYTES:-0}"
  if [[ "$required" =~ ^[0-9]+$ && ${#required} -le 18 ]]; then
    shortfall=$(( required > capacity_after ? required - capacity_after : 0 ))
    log "disk_admission required_bytes=$required shortfall_bytes=$shortfall"
  else
    log "disk_admission=unknown reason=invalid_required_bytes"
  fi
else
  log "disk_headroom=unknown root=$REPORT_ROOT"
fi

if (( FAILURES > 0 )); then
  log "cleanup incomplete: ${FAILURES} eligible artifact(s) could not be removed" >&2
  exit 1
fi

exit 0
