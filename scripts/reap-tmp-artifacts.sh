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

sweep_by_age "${TMP_ROOT}/bridge-out"
sweep_by_age "${TMP_ROOT}" "bridge-uploads-*"
sweep_by_age "${TMP_ROOT}" "antigravity-*.log"
sweep_by_age "${TMP_ROOT}" "agent-bridge-advisor-*.sock"
sweep_by_age "${TMP_ROOT}/agent-bridge-voice" "voice-*"
sweep_agent_bridge_scratch "${TMP_ROOT}"

IFS=',' read -r -a REPOS <<< "${REAP_WORKTREE_REPOS:-${HOME:-}/agent-bridge}"
for repo in "${REPOS[@]}"; do
  [[ -n "$repo" ]] && reap_worktree_repo "$repo"
done

if (( FAILURES > 0 )); then
  log "cleanup incomplete: ${FAILURES} eligible artifact(s) could not be removed" >&2
  exit 1
fi

exit 0