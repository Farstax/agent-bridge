/**
 * PURPOSE: Resolve and wrap CLI invocations with an OS-backed exclusive lock for their canonical Git worktree.
 * INPUTS: CLI command arguments and the requested working directory.
 * OUTPUTS: A fail-closed flock invocation for Git worktrees, or the original invocation outside Git.
 * NEIGHBORS: src/cli.ts
 * LOGIC: Finds the nearest .git marker, resolves its worktree-specific Git directory, and uses flock --no-fork so the supervised PID remains the waiter/holder/CLI process.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface WorkspaceLock {
  worktreeRoot: string;
  lockFile: string;
}

export interface LockedInvocation {
  command: string;
  args: string[];
  workspaceLock: WorkspaceLock | null;
}

const LOCK_FILE_NAME = "agent-bridge-execution.lock";
const FLOCK_CANDIDATES = ["/usr/bin/flock", "/bin/flock"];

/**
 * Workspace locking is enabled by default for fail-safe compatibility. The
 * companion/provider services can explicitly opt out because they share the
 * canonical checkout by design; ordinary runs retain locking in their isolated
 * worktrees.
 */
function workspaceLockEnabled(): boolean {
  return process.env.BRIDGE_WORKSPACE_LOCK_MODE !== "off";
}

function resolveGitDir(marker: string): string | null {
  try {
    if (statSync(marker).isDirectory()) return realpathSync(marker);
    const match = readFileSync(marker, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return null;
    const gitDir = isAbsolute(match[1]) ? match[1] : resolve(dirname(marker), match[1]);
    return realpathSync(gitDir);
  } catch {
    return null;
  }
}

/** Finds the nearest Git worktree without launching an unsupervised helper process. */
export function resolveWorkspaceLock(cwd: string): WorkspaceLock | null {
  let current: string;
  try {
    current = realpathSync(cwd);
  } catch {
    return null;
  }

  while (true) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      const gitDir = resolveGitDir(marker);
      if (gitDir) return { worktreeRoot: current, lockFile: join(gitDir, LOCK_FILE_NAME) };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveFlockCommand(): string {
  const command = FLOCK_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!command) {
    throw new Error("OS workspace locking requires util-linux flock at /usr/bin/flock or /bin/flock");
  }
  return command;
}

export function buildWorkspaceLockedInvocation(
  command: string,
  args: string[],
  cwd: string,
  opts: { bypassWorkspaceLock?: boolean } = {},
): LockedInvocation {
  // Narrowly scoped opt-out for verified fresh, read-only, tool-free
  // invocations (Issue #177 /btw) — never a general-purpose toggle.
  if (opts.bypassWorkspaceLock) return { command, args, workspaceLock: null };
  if (!workspaceLockEnabled()) return { command, args, workspaceLock: null };
  const workspaceLock = resolveWorkspaceLock(cwd);
  if (!workspaceLock) return { command, args, workspaceLock: null };
  return {
    command: resolveFlockCommand(),
    args: ["--exclusive", "--no-fork", workspaceLock.lockFile, command, ...args],
    workspaceLock,
  };
}
