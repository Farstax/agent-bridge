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
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

log() { echo "[reap-tmp-artifacts] $*"; }

remove_entry() {
  local entry="$1" reason="$2"
  if (( DRY_RUN )); then
    log "would remove ($reason): $entry"
  else
    log "removing ($reason): $entry"
    rm -rf -- "$entry"
  fi
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
              if (( DRY_RUN )); then
                log "would remove worktree (merged+clean): $wt [$branch]"
              else
                log "removing worktree (merged+clean): $wt [$branch]"
                git -C "$repo" worktree remove --force "$wt" 2>/dev/null \
                  && git -C "$repo" branch -D "$branch" 2>/dev/null
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
sweep_agent_bridge_scratch "${TMP_ROOT}"

IFS=',' read -r -a REPOS <<< "${REAP_WORKTREE_REPOS:-${HOME:-}/agent-bridge}"
for repo in "${REPOS[@]}"; do
  [[ -n "$repo" ]] && reap_worktree_repo "$repo"
done

exit 0
