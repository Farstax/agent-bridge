/**
 * Stable per-conversation execution directories. Agents retain responsibility
 * for creating Git worktrees; Bridge only assigns and removes owned folders.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveWorkspaceLock } from "./workspaceLock.js";

export interface ConversationDirectoryIdentity {
  surfaceIdentity: string;
  chatKey: string;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function conversationDirectorySettingKey(identity: ConversationDirectoryIdentity): string {
  return `conversation-directory:v1:${digest(JSON.stringify([identity.surfaceIdentity, identity.chatKey]))}`;
}

/** Returns a path outside the original Git checkout, or inside a non-Git workspace root. */
export function conversationDirectoryPath(sourceCwd: string, identity: ConversationDirectoryIdentity): string {
  if (!identity.surfaceIdentity || !identity.chatKey) throw new Error("conversation identity is required");
  const source = realpathSync(sourceCwd);
  let parent = source;
  while (true) {
    const lock = resolveWorkspaceLock(parent);
    if (!lock) break;
    const next = dirname(lock.worktreeRoot);
    if (next === parent) throw new Error("no location outside the source checkout");
    parent = next;
  }
  return join(parent, ".agent-bridge-conversations", digest(source).slice(0, 16),
    digest(JSON.stringify([identity.surfaceIdentity, identity.chatKey])).slice(0, 32));
}

export function ensureConversationDirectory(sourceCwd: string, identity: ConversationDirectoryIdentity): string {
  const path = conversationDirectoryPath(sourceCwd, identity);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("conversation directory must not be a symlink");
  }
  return path;
}

/** Archive can only delete the exact directory Bridge assigned to this conversation. */
export function deleteConversationDirectory(
  sourceCwd: string, identity: ConversationDirectoryIdentity, ownedPath: string,
): void {
  const expected = conversationDirectoryPath(sourceCwd, identity);
  if (ownedPath !== expected) throw new Error("refusing to delete a directory not owned by this conversation");
  if (!existsSync(expected)) return;
  if (lstatSync(expected).isSymbolicLink() || realpathSync(expected) !== expected) {
    throw new Error("refusing to delete a symlinked conversation directory");
  }
  rmSync(expected, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  // Removing a nested agent-created worktree can leave a registration behind.
  // Pruning missing registrations does not delete commits or shared branches.
  const lock = resolveWorkspaceLock(sourceCwd);
  if (lock) execFileSync("git", ["-C", lock.worktreeRoot, "worktree", "prune"],
    { stdio: "ignore", timeout: 10_000 });
}
