import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

describe("autonomous engine isolation (#466)", () => {
  it("uses an explicit per-engine cwd without changing process cwd", () => {
    const dbPath = join(tmpdir(), `autonomy-engine-${Math.random()}.sqlite`);
    const db = openDb(dbPath, { serviceId: "test", runId: "test" });
    const before = process.cwd();
    const engine = new BridgeEngine({
      kind: "autonomous", surfaceIdentity: "autonomous", executionKind: "claude",
      botConfig: { command: "claude", modelPreference: ["default"] }, allowedUserIds: new Set(["1"]),
      executionMode: "safe", pollIntervalMs: 1,
      workingDir: "/tmp/autonomy-work", workspaceContext: "canonical context",
    }, db, { getUpdates: vi.fn(), sendMessage: vi.fn(), sendChatAction: vi.fn() } as any);
    expect((engine as any)._workingDir("claude")).toBe("/tmp/autonomy-work");
    expect(process.cwd()).toBe(before);
    db.close(); try { rmSync(dbPath); } catch {}
  });
});
