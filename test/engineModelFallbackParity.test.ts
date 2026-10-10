import { describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { BridgeEvent } from "../src/events/types.js";

const CAPACITY = new Error("usage limit reached");

function client() {
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function setup(runProviderInvocation: any, hooks: any = {}) {
  const db = openDb(":memory:");
  const telegram = client();
  const engine = new BridgeEngine({
    surfaceIdentity: "acp:model-fallback",
    kind: "codex",
    botConfig: { command: "codex", modelPreference: ["model-a", "model-b"] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe",
    pollIntervalMs: 1000,
    workingDir: process.cwd(),
    hooks,
  }, db, telegram, { runProviderInvocation } as any);
  const events: BridgeEvent[] = [];
  const run = async (laneHook?: (lane: any) => void) => {
    const lane = db.acquireLock("acp:model-fallback", "k");
    if (!lane) throw new Error("lane unavailable");
    laneHook?.(lane);
    return engine.executeSurfaceNeutralTurn({
      prompt: "task", sessionId: null, chatId: "chat-1", chatKey: "k", laneHandle: lane, runId: "run-1",
      eventContext: { runId: "run-1", bot: "codex", chatId: "chat-1", chatKey: "k" } as any,
      collect: (event) => events.push(event),
    });
  };
  // The messaging entry owner publishes generated files (publishArtifacts default).
  const runMessaging = async (laneHook?: (lane: any) => void) => {
    const lane = db.acquireLock("acp:model-fallback", "k");
    if (!lane) throw new Error("lane unavailable");
    laneHook?.(lane);
    return engine.executePromptAsync(
      "task", null, 100, {}, () => {}, [],
      { runId: "run-1", bot: "codex", chatId: "100", chatKey: "k" } as any,
      "run-1", (event) => events.push(event), "k", lane,
    );
  };
  return { db, telegram, engine, events, run, runMessaging };
}

describe("same-provider model fallback uses the normal provider-attempt success path", () => {
  it("emits one run.completed, publishes the generated file once and runs hooks once", async () => {
    const requests: any[] = [];
    const runProviderInvocation = vi.fn(async (_k: string, _i: any, _cwd: string, _o: any, request: any) => {
      requests.push(request);
      if (requests.length === 1) throw CAPACITY;
      writeFileSync(join(request.outputDir, "report.txt"), "generated");
      return { text: "fallback answer", sessionId: "model-b-session", stopReason: "end_turn" };
    });
    const onAfterExecute = vi.fn();
    const { db, telegram, events, runMessaging } = setup(runProviderInvocation, { onAfterExecute });
    try {
      const result = await runMessaging();
      expect(runProviderInvocation).toHaveBeenCalledTimes(2);
      expect(requests[0].model).toBe("model-a");
      expect(requests[1].model).toBe("model-b");
      expect(requests[1].sessionId).toBeNull();
      expect(result.text).toContain("Fell back to model-b");
      expect(result.text).toContain("fallback answer");
      expect(result.sessionId).toBe("model-b-session");
      const completed = events.filter((event) => event.type === "run.completed");
      expect(completed).toHaveLength(1);
      expect((completed[0] as any).text).toContain("fallback answer");
      expect(telegram.sendDocument).toHaveBeenCalledTimes(1);
      expect(onAfterExecute).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("does not fall back a second time when the alternate model also fails", async () => {
    const runProviderInvocation = vi.fn(async () => { throw CAPACITY; });
    const { db, events, run } = setup(runProviderInvocation);
    try {
      await expect(run()).rejects.toThrow(/usage limit/);
      expect(runProviderInvocation).toHaveBeenCalledTimes(2);
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
    } finally { db.close(); }
  });

  it("publishes and completes nothing when ownership is lost during the alternate attempt", async () => {
    let outputDir = "";
    let laneHandle: any;
    let calls = 0;
    const runProviderInvocation = vi.fn(async (_k: string, _i: any, _cwd: string, _o: any, request: any) => {
      calls += 1;
      if (calls === 1) throw CAPACITY;
      outputDir = request.outputDir;
      writeFileSync(join(request.outputDir, "late.txt"), "must not publish");
      db.unlock(laneHandle);
      return { text: "late answer", sessionId: "s", stopReason: "end_turn" };
    });
    const { db, telegram, events, runMessaging } = setup(runProviderInvocation);
    try {
      await expect(runMessaging((lane) => { laneHandle = lane; })).rejects.toThrow();
      expect(telegram.sendDocument).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
      expect(outputDir).not.toBe("");
      expect(existsSync(outputDir)).toBe(false);
    } finally { db.close(); }
  });

  it("treats a provider-cancelled alternate attempt as cancelled, not completed", async () => {
    let calls = 0;
    const runProviderInvocation = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw CAPACITY;
      return { text: "partial", sessionId: "s", stopReason: "cancelled" };
    });
    const onAfterExecute = vi.fn();
    const { db, events, run } = setup(runProviderInvocation, { onAfterExecute });
    try {
      const result = await run();
      expect(result.stopReason).toBe("cancelled");
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
      expect(events.some((event) => event.type === "run.cancelled")).toBe(true);
      expect(onAfterExecute).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});

describe("non-messaging Run artifact boundary (#954 C)", () => {
  it("never sends generated files to the messaging client for a surface-neutral Run and removes the staged output", async () => {
    let outputDir = "";
    const runProviderInvocation = vi.fn(async (_k: string, _i: any, _cwd: string, _o: any, request: any) => {
      outputDir = request.outputDir;
      writeFileSync(join(request.outputDir, "artifact.txt"), "generated by an autonomous cycle");
      return { text: "cycle done", sessionId: "s", stopReason: "end_turn" };
    });
    const { db, telegram, run } = setup(runProviderInvocation);
    try {
      await run();
      expect(telegram.sendDocument).not.toHaveBeenCalled();
      expect(telegram.sendPhoto).not.toHaveBeenCalled();
      expect(existsSync(outputDir)).toBe(false);
    } finally { db.close(); }
  });
});
