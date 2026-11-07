import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { BotKind } from "../src/types.js";

describe("isolated read-only /btw invocation (#1159)", () => {
  it.each(["codex", "cursor", "claude"] as const)("uses fresh safe ACP read-only intent for %s without mutating the main conversation", async (kind) => {
    const db = openDb(":memory:");
    const invocation = vi.fn(async (..._args: any[]) => ({ text: "read answer", sessionId: "side-session", stopReason: "end_turn" }));
    const client = { capabilities: TELEGRAM_SURFACE_CAPABILITIES } as any;
    const engine = new BridgeEngine({
      surfaceIdentity: "test:btw",
      kind,
      botConfig: { command: kind, modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "trusted",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
    }, db, client, { runProviderInvocation: invocation } as any);
    db.addConvTurn("chat1", "user", "main conversation", kind, { surfaceIdentity: "test:btw" });
    try {
      expect(await engine.executeSurfaceNeutralBtw("inspect sources", "chat1")).toBe("read answer");
      expect(invocation).toHaveBeenCalledOnce();
      const [provider, built, cwd, options, request, identities] = invocation.mock.calls[0]!;
      expect(provider).toBe(kind);
      expect(built).toMatchObject({ transport: "acp-stdio", nativeSessionMode: "fresh" });
      expect(cwd).toBe(process.cwd());
      expect(options).toMatchObject({ bypassWorkspaceLock: true });
      expect(request).toMatchObject({
        sessionId: null,
        executionMode: "safe",
        toolMode: "default",
        readOnlySideQuestion: true,
        attachments: [],
        outputDir: null,
      });
      expect(request.prompt).toContain("This is a fresh, read-only side question.");
      expect(request.prompt).not.toContain("Agent Bridge execution contract:");
      expect(identities).toMatchObject({ conversationId: "chat1:btw" });
      expect(db.getRecentConvTurns("chat1", 10, undefined, "test:btw").map((turn) => turn.text)).toEqual(["main conversation"]);
      expect(db.getSession({ surfaceIdentity: "test:btw", chatKey: "chat1" }, kind)).toBeNull();
    } finally {
      db.close();
    }
  });

  it.each(["grok", "antigravity"] as BotKind[])("rejects unsupported %s before invoking ACP", async (kind) => {
    const db = openDb(":memory:");
    const invocation = vi.fn();
    const engine = new BridgeEngine({
      surfaceIdentity: "test:btw", kind,
      botConfig: { command: kind, modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
    }, db, { capabilities: TELEGRAM_SURFACE_CAPABILITIES } as any, { runProviderInvocation: invocation } as any);
    try {
      await expect(engine.executeSurfaceNeutralBtw("inspect", "chat1")).rejects.toThrow(/unavailable/);
      expect(invocation).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
