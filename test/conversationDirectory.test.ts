import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationDirectoryPath, deleteConversationDirectory, ensureConversationDirectory } from "../src/conversationDirectory.js";
import { resolveWorkspaceLock } from "../src/workspaceLock.js";
import { openDb } from "../src/db.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function source() {
  const root = mkdtempSync(join(tmpdir(), "bridge-conversation-"));
  roots.push(root);
  return root;
}
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

describe("conversation-owned execution directories (#1179)", () => {
  it("keeps conversations apart and preserves distinct Git worktree locks", () => {
    const root = source();
    const repository = join(root, "repo");
    execFileSync("git", ["init", "-q", repository]);
    git(repository, "config", "user.email", "test@example.com");
    git(repository, "config", "user.name", "Test");
    writeFileSync(join(repository, "README.md"), "test");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "initial");
    const firstId = { surfaceIdentity: "acp:outward", chatKey: "acp:first" };
    const secondId = { surfaceIdentity: "acp:outward", chatKey: "acp:second" };
    const first = ensureConversationDirectory(repository, firstId);
    const second = ensureConversationDirectory(repository, secondId);
    expect(first).not.toBe(second);
    expect(first.startsWith(join(root, ".agent-bridge-conversations"))).toBe(true);
    expect(ensureConversationDirectory(repository, firstId)).toBe(first);
    expect(resolveWorkspaceLock(first)).toBeNull();
    git(repository, "worktree", "add", "-q", "--detach", first);
    git(repository, "worktree", "add", "-q", "--detach", second);
    expect(resolveWorkspaceLock(first)?.lockFile).not.toBe(resolveWorkspaceLock(second)?.lockFile);
    deleteConversationDirectory(repository, firstId, first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(git(repository, "worktree", "list", "--porcelain")).not.toContain(first);
    expect(existsSync(repository)).toBe(true);
  });

  it("never deletes a legacy checkout or another conversation", () => {
    const root = source();
    const first = { surfaceIdentity: "telegram:interactive", chatKey: "123" };
    const second = { surfaceIdentity: "telegram:interactive", chatKey: "456" };
    const owned = ensureConversationDirectory(root, first);
    const another = ensureConversationDirectory(root, second);
    expect(() => deleteConversationDirectory(root, first, root)).toThrow(/not owned/);
    expect(() => deleteConversationDirectory(root, first, another)).toThrow(/not owned/);
    expect(existsSync(owned)).toBe(true);
    expect(existsSync(another)).toBe(true);
    deleteConversationDirectory(root, first, owned);
    expect(existsSync(another)).toBe(true);
    expect(conversationDirectoryPath(root, first)).toBe(owned);
  });

  it("persists execution cwd without changing the ACP workspace listing scope", () => {
    const root = source();
    const db = openDb(join(root, "test.sqlite"), { databaseRole: "interactive" });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      const executionCwd = ensureConversationDirectory(root, { surfaceIdentity: "acp:outward", chatKey: "acp:one" });
      sessions.create({ sessionId: "one", conversationId: "acp:one", cwd: root, executionCwd });
      sessions.create({ sessionId: "legacy", conversationId: "acp:old", cwd: root });
      expect(sessions.get("one")?.executionCwd).toBe(executionCwd);
      expect(sessions.get("legacy")?.executionCwd).toBeNull();
      expect(sessions.list(root)).toHaveLength(2);
    } finally { db.close(); }
  });
});
