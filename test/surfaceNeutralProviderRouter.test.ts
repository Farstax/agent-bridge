import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { createSurfaceNeutralProviderRouter } from "../src/surfaceNeutralProviderRouter.js";
import type { BotKind } from "../src/types.js";

function event(input: any, type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    version: 1,
    id: `${type}-${Math.random()}`,
    runId: input.runId,
    timestamp: new Date().toISOString(),
    bot: input.eventContext.bot,
    chatId: input.eventContext.chatId,
    ...extra,
  } as any;
}

function turnInput(collect: (event: any) => void, onProviderExecutionStarted = vi.fn()) {
  return {
    prompt: "bounded work",
    sessionId: null,
    chatId: 0,
    chatKey: "autonomous:episode-1",
    laneHandle: {} as any,
    runId: "run-1",
    eventContext: {
      runId: "run-1",
      bot: "claude" as const,
      chatId: "autonomous:episode-1",
      serviceId: "test",
      acquisitionId: "test",
    },
    collect,
    onProviderExecutionStarted,
  };
}

describe("surface-neutral provider attempt isolation", () => {
  it("keeps only the final same-provider attempt and publishes its parsed completion", async () => {
    const db = openDb(":memory:");
    const collected: any[] = [];
    const attemptBoundary = vi.fn();
    const engine = {
      executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
        input.collect(event(input, "run.started", { model: "claude-primary", command: "claude", cwd: "/tmp" }));
        input.collect(event(input, "run.failed", { error: "capacity", category: "cli" }));
        input.collect(event(input, "run.started", { model: "claude-fallback", command: "claude", cwd: "/tmp" }));
        input.collect(event(input, "run.completed", { text: "raw provider envelope", sessionId: null }));
        return { text: "parsed fallback answer", sessionId: "session-2" };
      }),
    };
    const router = createSurfaceNeutralProviderRouter({
      db,
      initialProvider: "claude",
      providerChain: ["claude"],
      engineForProvider: () => engine as any,
    });

    try {
      const result = await router.executeSurfaceNeutralTurn(turnInput((value) => collected.push(value), attemptBoundary));
      expect(result).toEqual({ text: "parsed fallback answer", sessionId: "session-2" });
      expect(attemptBoundary).toHaveBeenCalledTimes(2);
      expect(collected.map((value) => value.type)).toEqual(["run.started", "run.completed"]);
      expect(collected[0].model).toBe("claude-fallback");
      expect(collected[1]).toMatchObject({ text: "parsed fallback answer", sessionId: "session-2" });
    } finally {
      db.close();
    }
  });

  it("discards an exhausted CLI terminal event before advancing to the next provider", async () => {
    const db = openDb(":memory:");
    const collected: any[] = [];
    const attemptBoundary = vi.fn();
    const claude = {
      executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
        input.collect(event(input, "run.started", { model: "claude", command: "claude", cwd: "/tmp" }));
        input.collect(event(input, "run.failed", { error: "rate limit capacity exhausted", category: "cli" }));
        throw new Error("rate limit capacity exhausted");
      }),
    };
    const codex = {
      executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
        input.collect(event(input, "run.started", { model: "codex", command: "codex", cwd: "/tmp" }));
        input.collect(event(input, "run.completed", { text: "raw codex envelope", sessionId: null }));
        return { text: "authoritative codex answer", sessionId: "codex-session" };
      }),
    };
    const engines: Record<BotKind, any> = { claude, codex, antigravity: codex };
    const router = createSurfaceNeutralProviderRouter({
      db,
      initialProvider: "claude",
      providerChain: ["claude", "codex"],
      engineForProvider: (provider) => engines[provider],
    });

    try {
      const result = await router.executeSurfaceNeutralTurn(turnInput((value) => collected.push(value), attemptBoundary));
      expect(result.text).toBe("authoritative codex answer");
      expect(claude.executeSurfaceNeutralTurn).toHaveBeenCalledOnce();
      expect(codex.executeSurfaceNeutralTurn).toHaveBeenCalledOnce();
      expect(attemptBoundary).toHaveBeenCalledTimes(2);
      expect(collected.map((value) => value.type)).toEqual(["run.started", "run.completed"]);
      expect(collected[0].bot).toBe("codex");
      expect(collected[1]).toMatchObject({ bot: "codex", text: "authoritative codex answer", sessionId: "codex-session" });
    } finally {
      db.close();
    }
  });

  it("preserves the final provider failure when no fallback remains", async () => {
    const db = openDb(":memory:");
    const collected: any[] = [];
    const engine = {
      executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
        input.collect(event(input, "run.started", { model: "claude", command: "claude", cwd: "/tmp" }));
        input.collect(event(input, "run.failed", { error: "rate limit capacity exhausted", category: "cli" }));
        throw new Error("rate limit capacity exhausted");
      }),
    };
    const router = createSurfaceNeutralProviderRouter({
      db,
      initialProvider: "claude",
      providerChain: ["claude"],
      engineForProvider: () => engine as any,
    });

    try {
      await expect(router.executeSurfaceNeutralTurn(turnInput((value) => collected.push(value)))).rejects.toThrow("rate limit capacity exhausted");
      expect(collected.map((value) => value.type)).toEqual(["run.started", "run.failed"]);
    } finally {
      db.close();
    }
  });
});
