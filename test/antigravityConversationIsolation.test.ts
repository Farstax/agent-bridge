import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAntigravityConversationId } from "../src/providers/antigravityRuntime.js";

describe("Antigravity conversation isolation", () => {
  it("does not infer a bridge session from provider-global logs or cwd cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-conversation-isolation-"));
    const homeDir = join(root, "home");
    const logDir = join(homeDir, ".gemini", "antigravity-cli", "log");
    const cacheDir = join(homeDir, ".gemini", "antigravity-cli", "cache");
    const otherChatConversationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await mkdir(logDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(logDir, "agy-other-chat.log"), `Print mode: conversation=${otherChatConversationId}\n`);
    await writeFile(
      join(cacheDir, "last_conversations.json"),
      JSON.stringify({ [root]: otherChatConversationId }),
    );

    try {
      expect(resolveAntigravityConversationId({
        cwd: root,
        sinceMs: Date.now(),
        explicitLogContent: null,
        homeDir,
        allowSharedStateFallback: false,
      })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves provider-global session discovery for untracked callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-untracked-session-"));
    const homeDir = join(root, "home");
    const cacheDir = join(homeDir, ".gemini", "antigravity-cli", "cache");
    const conversationId = "11111111-2222-3333-4444-555555555555";
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "last_conversations.json"),
      JSON.stringify({ [root]: conversationId }),
    );

    try {
      expect(resolveAntigravityConversationId({
        cwd: root,
        sinceMs: Date.now(),
        explicitLogContent: null,
        homeDir,
        allowSharedStateFallback: true,
      })).toBe(conversationId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
