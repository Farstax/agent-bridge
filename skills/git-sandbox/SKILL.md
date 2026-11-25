---
name: git-sandbox
description: "Use for isolating substantial changes with Git worktrees, draft PRs, sandbox testing and safe checkout/branch cleanup after delivery or abandonment."
---

# Git Sandbox and Feature Branch Isolation Workflow

Use isolated worktrees for substantial changes when useful. Keep the primary checkout and other agents' work intact.

## Workflow

1. Record the owning task, primary checkout, feature branch and worktree path. Create an isolated feature branch (for example, `git worktree add ../worktree-name -b feature/name`). Prefer a local dependency installation when versions differ. If sharing dependencies, link directly to a stable primary checkout only when manifests, lockfiles and runtime are compatible and the work will not mutate that installation or compromise qualification. Do not link temporary worktrees to each other or install through a shared link.
2. Follow the existing TDD and delivery Skills. Push the feature branch and open a draft PR using the available authorized repository integration (CLI, MCP or API). Do not require `gh`, another login or a new credential.
3. Complete the agreed review and exact-head checks, then merge through the same authorized integration (squash preferred). Verify the actual merge before cleanup. The merging agent owns cleanup; do not report delivery complete merely because the PR merged.

## Cleanup

Apply this procedure to completed features, spikes, closed-unmerged or superseded approaches, and disposable clones you own. If handing over unfinished work, preserve it and explicitly transfer the checkout, branch and cleanup obligation.

- **Prove disposition.** Record the exact checkout HEAD and local branch tip. For a merged branch, verify the actual upstream default branch and integration of the exact tip by ancestry; for a squash, verify that the merged PR's head equals that tip and its merge commit is reachable from the current upstream default. A stale tracking ref, PR title, missing remote branch or patch similarity alone is not proof. For other completed or abandoned work, review unique commits and tracked, untracked and ignored changes; preserve recoverable work or establish explicit authorized discard before removing anything. Never infer permission to discard unknown work from a closed issue.
- **Protect ownership and shared dependencies.** Check Git status (including ignored files and hidden index entries), registered worktrees and active or pending work. Leave locked, active, protected, dirty or uncertain checkouts intact until resolved. Identify incoming dependency links, including chained links; clean eligible dependents first, or retain their target. Unlink only an identified untracked disposable dependency symlink itself, never its target. Remove a local dependency directory only when it is untracked, reproducible, inactive and not shared. Preserve all unknown files. Recheck these conditions immediately before removal.
- **Remove from outside the target.** Leave the feature worktree; do not check out main inside it. From the verified primary checkout, run normal `git -C "$primary" worktree remove "$worktree"`. Do not force worktree removal or use blanket `git clean`. For a disposable standalone clone, remove only the identified clone after the same preservation and ownership checks; never remove the primary or a retained reference clone. If removal is refused, resolve the actual blocker or retain and report it.
- **Remove only the eligible local feature branch.** Verify no registered worktree uses it, it is neither primary/default nor protected, and its tip has not changed. Prefer `git -C "$primary" branch -d -- "$branch"` when Git's merge check agrees with the verified upstream evidence. If Git refuses a verified squash merge solely because ancestry differs, use `git -C "$primary" update-ref -d "refs/heads/$branch" "$verified_tip"` to delete only that exact verified tip. Apply the same exact-tip guard to any explicitly authorized discarded branch. Do not force-delete unknown branches. Remote deletion requires the existing repository authority and separate eligibility; never delete an unrelated remote branch.
- **Verify completion.** Read back worktree registrations, local refs, retained work and dependency targets. Prune only verified stale worktree registrations; inspect with `git worktree prune --dry-run` first. Confirm removed paths are gone. If a checkout cannot be safely removed, report its path, exact blocker, owning work and next action in the delivery report rather than silently leaving it behind. The janitor is recovery for interrupted work, not a substitute for this cleanup.
