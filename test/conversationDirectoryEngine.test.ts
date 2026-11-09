import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeEngine } from "../src/engine.js";
import { getCliWorkingDir } from "../src/bridge.js";
import { openDb } from "../src/db.js";

const roots: string[] = [];
const originalProjectDir = process.env.BRIDGE_PROJECT_DIR;
afterEach(() => {
  if (originalProjectDir === undefined) delete process.env.BRIDGE_PROJECT_DIR;
  else process.env.BRIDGE_PROJECT_DIR = originalProjectDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("messaging conversation execution directory (#1179)", () => {
  it("keeps provider switches and restarts in the same directory, isolated by surface", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-message-cwd-"));
    roots.push(root);
    process.env.BRIDGE_PROJECT_DIR = root;
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      function engine(surfaceIdentity: string) {
        return new BridgeEngine({
          kind: "codex", surfaceIdentity, botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(), executionMode: "safe", pollIntervalMs: 1_000,
          isolatedConversationDirectories: true,
        }, db, {} as never);
      }
      const workingDir = (instance: BridgeEngine, provider: "codex" | "claude", chatKey: string): string =>
        (instance as unknown as { _workingDir(provider: string, chatKey: string): string })
          ._workingDir(provider, chatKey);
      const telegram = engine("telegram:interactive");
      const first = workingDir(telegram, "codex", "chat-one");
      expect(existsSync(first)).toBe(true);
      expect(workingDir(telegram, "claude", "chat-one")).toBe(first);
      expect(workingDir(engine("telegram:interactive"), "codex", "chat-one")).toBe(first);
      expect(workingDir(telegram, "codex", "chat-two")).not.toBe(first);
      expect(workingDir(engine("discord:interactive"), "codex", "chat-one")).not.toBe(first);
      expect(workingDir(engine("slack:interactive"), "codex", "chat-one")).not.toBe(first);
      db.addConvTurn("old-chat", "assistant", "prior reply", undefined,
        { surfaceIdentity: "telegram:interactive" });
      expect(workingDir(telegram, "codex", "old-chat")).toBe(getCliWorkingDir("codex"));
    } finally {
      db.close();
    }
  });
});
