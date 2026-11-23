import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { createSurfaceNeutralProviderRouter } from "../src/surfaceNeutralProviderRouter.js";
import { recordRunOutcome } from "../src/runOutcome.js";
import { attachProviderFailureEvidence } from "../src/providers/failureEvidence.js";
import { listRunContinuations, requestRunContinuation } from "../src/runContinuation.js";
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


  it("reports only real cross-provider transitions, in order, with classified reasons", async () => {
    const db = openDb(":memory:");
    const recovery = vi.fn();
    const attempts: BotKind[] = [];
    const failures: Partial<Record<BotKind, string>> = {
      claude: "rate limit capacity exhausted",
      codex: "authentication required",
    };
    const router = createSurfaceNeutralProviderRouter({
      db, initialProvider: "claude", providerChain: ["claude", "codex", "grok"],
      engineForProvider: (provider) => ({
        executeSurfaceNeutralTurn: async () => {
          attempts.push(provider);
          if (failures[provider]) throw new Error(failures[provider]);
          return { text: "done", sessionId: "grok-session" };
        },
      }) as any,
    });
    try {
      await expect(router.executeSurfaceNeutralTurn({
        ...turnInput(vi.fn()), onProviderRecoveryDecision: recovery,
      })).resolves.toMatchObject({ text: "done" });
      expect(attempts).toEqual(["claude", "codex", "grok"]);
      expect(recovery.mock.calls).toEqual([
        ["capacity", false, { fromProvider: "claude", toProvider: "codex" }],
        ["auth_required", false, { fromProvider: "codex", toProvider: "grok" }],
      ]);
    } finally { db.close(); }
  });

  it("fences the durable provider before a native fallback outcome helper runs", async () => {
    const db = openDb(":memory:");
    const chatKey = "acp:fallback-provider-fence";
    const identity = { surfaceIdentity: "acp:outward", chatKey };
    db.insertRun("fenced-run", identity, "claude");
    const lane = db.acquireLock(identity.surfaceIdentity, chatKey, false);
    expect(lane).not.toBeNull();
    const seen: string[] = [];
    const router = createSurfaceNeutralProviderRouter({
      db, surfaceIdentity: identity.surfaceIdentity,
      initialProvider: "claude", providerChain: ["claude", "codex"],
      engineForProvider: (provider) => ({
        executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
          seen.push(provider);
          expect(db.getRun(input.runId).bot).toBe(provider);
          if (provider === "claude") {
            recordRunOutcome(db, {
              runId: input.runId, surfaceIdentity: identity.surfaceIdentity,
              chatKey, provider, status: "continue", detail: "stale capacity wait",
              lock: { serviceId: lane!.serviceId, runId: lane!.runId, acquisitionId: lane!.acquisitionId },
            });
            requestRunContinuation(db, {
              originRunId: input.runId, ...identity, provider,
              reason: "stale capacity wait", afterSeconds: 5, outwardSessionId: "workstream",
            });
            throw new Error("usage limit reached");
          }
          recordRunOutcome(db, {
            runId: input.runId, surfaceIdentity: identity.surfaceIdentity,
            chatKey, provider, status: "complete", detail: "verified",
            lock: { serviceId: lane!.serviceId, runId: lane!.runId, acquisitionId: lane!.acquisitionId },
          });
          return { text: "finished with native outcome", sessionId: "codex-session", stopReason: "end_turn" };
        }),
      }) as any,
    });
    try {
      const input = { ...turnInput(vi.fn()), chatKey, runId: "fenced-run", laneHandle: lane! };
      await router.executeSurfaceNeutralTurn(input);
      expect(seen).toEqual(["claude", "codex"]);
      expect(db.getRun("fenced-run")).toMatchObject({
        bot: "codex", outcome_status: "complete", outcome_detail: "verified",
      });
      expect(listRunContinuations(db, identity.surfaceIdentity)).toEqual([
        expect.objectContaining({ state: "cancelled", reason: "stale capacity wait" }),
      ]);
    } finally {
      db.unlock(lane!);
      db.close();
    }
  });

  it("does not abandon a recorded outcome when the provider fails after disposition", async () => {
    const db = openDb(":memory:");
    const identity = { surfaceIdentity: "acp:outward", chatKey: "autonomous:episode-1" };
    db.insertRun("run-1", identity, "claude");
    const lane = db.acquireLock(identity.surfaceIdentity, identity.chatKey);
    expect(lane).not.toBeNull();
    recordRunOutcome(db, {
      runId: "run-1", surfaceIdentity: identity.surfaceIdentity, chatKey: identity.chatKey,
      provider: "claude", status: "complete", detail: "verified",
      lock: { serviceId: lane!.serviceId, runId: lane!.runId, acquisitionId: lane!.acquisitionId },
    });
    const next = vi.fn(async () => ({ text: "must not run", sessionId: "s" }));
    const router = createSurfaceNeutralProviderRouter({
      db, surfaceIdentity: identity.surfaceIdentity, initialProvider: "claude",
      providerChain: ["claude", "codex"],
      engineForProvider: (provider) => provider === "claude"
        ? { executeSurfaceNeutralTurn: async () => {
          throw attachProviderFailureEvidence(new Error("missing final answer"), { promptSubmitted: true });
        } } as any
        : { executeSurfaceNeutralTurn: next } as any,
    });
    try {
      await expect(router.executeSurfaceNeutralTurn({ ...turnInput(vi.fn()), laneHandle: lane! })).rejects.toThrow();
      expect(db.getRun("run-1").outcome_status).toBe("complete");
      expect(next).not.toHaveBeenCalled();
    } finally { db.unlock(lane!); db.close(); }
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


describe("two-stage provider recovery (#1281)", () => {
  it("recovers on the same provider with a fresh inspection-first session before any fallback", async () => {
    const db = openDb(":memory:");
    const attempts: Array<{ provider: BotKind; fresh: boolean | undefined; bound: boolean | undefined; prompt: string }> = [];
    const router = createSurfaceNeutralProviderRouter({
      db, surfaceIdentity: "acp:outward", initialProvider: "codex", providerChain: ["codex", "claude"],
      engineForProvider: (provider) => ({
        executeSurfaceNeutralTurn: async (input: any) => {
          attempts.push({ provider, fresh: input.freshProviderSession, bound: input.requireBoundProviderSession, prompt: input.prompt });
          if (attempts.length === 1) {
            const error = new Error("AcpSystemError: resumed session failed after tools");
            error.name = "AcpSystemError";
            throw attachProviderFailureEvidence(error, { promptSubmitted: true });
          }
          return { text: "verified unfinished work", sessionId: "codex-new-native-session" };
        },
      }) as any,
    });
    try {
      const result = await router.executeSurfaceNeutralTurn({
        ...turnInput(vi.fn()), requireBoundProviderSession: true,
      });
      expect(result.sessionId).toBe("codex-new-native-session");
      expect(attempts.map((entry) => entry.provider)).toEqual(["codex", "codex"]);
      expect(attempts.map((entry) => entry.bound)).toEqual([true, false]);
      expect(attempts[1].fresh).toBe(true);
      expect(attempts[1].prompt).toContain("AcpSystemError");
      expect(attempts[1].prompt).toContain("Inspect previous tool actions");
    } finally { db.close(); }
  });

  it("falls back to an authorised provider only after failed same-provider recovery", async () => {
    const db = openDb(":memory:");
    const toolsAlreadyPerformed = Array.from({ length: 9 }, (_, n) => `existing-tool-${n + 1}`);
    const attempts: Array<{ provider: BotKind; fresh: boolean | undefined; bound: boolean | undefined; prompt: string }> = [];
    const transitions = vi.fn();
    const router = createSurfaceNeutralProviderRouter({
      db, surfaceIdentity: "acp:outward", initialProvider: "codex", providerChain: ["codex", "claude"],
      engineForProvider: (provider) => ({
        executeSurfaceNeutralTurn: async (input: any) => {
          attempts.push({ provider, fresh: input.freshProviderSession, bound: input.requireBoundProviderSession, prompt: input.prompt });
          if (provider === "codex") {
            const error = new Error("AcpSystemError: interrupted after tool activity");
            error.name = "AcpSystemError";
            throw attachProviderFailureEvidence(error, { promptSubmitted: true });
          }
          expect(input.prompt).toContain("Inspect previous tool actions");
          // Existing tool effects are inspected, not blindly emitted again.
          expect(toolsAlreadyPerformed).toHaveLength(9);
          return { text: "remaining work verified", sessionId: "claude-native-session" };
        },
      }) as any,
    });
    try {
      const result = await router.executeSurfaceNeutralTurn({
        ...turnInput(vi.fn()), requireBoundProviderSession: true, onProviderRecoveryDecision: transitions,
      });
      expect(result.sessionId).toBe("claude-native-session");
      expect(attempts.map((item) => item.provider)).toEqual(["codex", "codex", "claude"]);
      expect(attempts.map((item) => item.fresh)).toEqual([false, true, true]);
      expect(attempts.map((item) => item.bound)).toEqual([true, false, false]);
      expect(attempts[2].prompt).toContain("AcpSystemError");
      expect(transitions).toHaveBeenCalledWith("provider_transport_failure", false, {
        fromProvider: "codex", toProvider: "claude",
      });
    } finally { db.close(); }
  });

  it("does not route an explicit refusal, local unknown error, or Stop through another provider", async () => {
    for (const errorType of ["refusal", "local", "stop"] as const) {
      const db = openDb(":memory:");
      const seen: BotKind[] = [];
      const router = createSurfaceNeutralProviderRouter({
        db, surfaceIdentity: "acp:outward", initialProvider: "codex", providerChain: ["codex", "claude"],
        engineForProvider: (provider) => ({
          executeSurfaceNeutralTurn: async () => {
            seen.push(provider);
            if (errorType === "refusal") {
              const refused = new Error("provider refused the request");
              refused.name = "MissingAcpAnswerError";
              (refused as Error & { stopReason?: string }).stopReason = "refusal";
              throw attachProviderFailureEvidence(refused, { promptSubmitted: true });
            }
            if (errorType === "stop") throw attachProviderFailureEvidence(new Error("socket hang up"), { promptSubmitted: true });
            throw new Error("ordinary repository exception");
          },
        }) as any,
      });
      try {
        await expect(router.executeSurfaceNeutralTurn({
          ...turnInput(vi.fn()), mayContinueRecovery: () => errorType !== "stop",
        })).rejects.toThrow();
        expect(seen).toEqual(["codex"]);
      } finally { db.close(); }
    }
  });

  it("a single-provider Workstream still bounds recovery and has no unauthorised fallback", async () => {
    const db = openDb(":memory:");
    const attempts: string[] = [];
    const router = createSurfaceNeutralProviderRouter({
      db, surfaceIdentity: "acp:outward", initialProvider: "codex", providerChain: ["codex"],
      engineForProvider: () => ({
        executeSurfaceNeutralTurn: async (input: any) => {
          attempts.push(input.freshProviderSession ? "fresh" : "bound");
          throw attachProviderFailureEvidence(new Error("AcpSystemError"), { promptSubmitted: true });
        },
      }) as any,
    });
    try {
      await expect(router.executeSurfaceNeutralTurn(turnInput(vi.fn()))).rejects.toThrow("AcpSystemError");
      expect(attempts).toEqual(["bound", "fresh"]);
    } finally { db.close(); }
  });
});

describe("surface-neutral provider availability (#954)", () => {
  function routerWith(chain: BotKind[], available: () => Set<string>, failures: Record<string, Error> = {}, onAttempt: (provider: string) => void = () => {}) {
    const db = openDb(":memory:");
    const calls: string[] = [];
    const router = createSurfaceNeutralProviderRouter({
      db,
      surfaceIdentity: "acp:availability",
      initialProvider: chain[0],
      providerChain: chain,
      isProviderAvailable: (provider) => available().has(provider),
      engineForProvider: (provider) => ({
        executeSurfaceNeutralTurn: vi.fn(async () => {
          calls.push(provider);
          onAttempt(provider);
          if (failures[provider]) throw failures[provider];
          return { text: `${provider} answer`, sessionId: provider };
        }),
      }) as any,
    });
    return { db, router, calls };
  }
  const input = () => turnInput(vi.fn());

  it("starts at the first routeable provider when the head is unavailable", async () => {
    const { db, router, calls } = routerWith(["codex", "claude", "grok"], () => new Set(["claude", "grok"]));
    try {
      expect((await router.executeSurfaceNeutralTurn(input() as any)).text).toBe("claude answer");
      expect(calls).toEqual(["claude"]);
    } finally { db.close(); }
  });

  it("skips an unavailable middle provider after a capacity failure", async () => {
    const { db, router, calls } = routerWith(
      ["codex", "claude", "grok"],
      () => new Set(["codex", "grok"]),
      { codex: new Error("usage limit reached") },
    );
    try {
      expect((await router.executeSurfaceNeutralTurn(input() as any)).text).toBe("grok answer");
      expect(calls).toEqual(["codex", "grok"]);
    } finally { db.close(); }
  });

  it("re-evaluates availability between attempts", async () => {
    let available = new Set(["codex", "claude", "grok"]);
    const { db, router, calls } = routerWith(
      ["codex", "claude", "grok"],
      () => available,
      { codex: new Error("usage limit reached") },
      (provider) => {
        // claude becomes unrouteable while the head provider is failing.
        if (provider === "codex") available = new Set(["codex", "grok"]);
      },
    );
    try {
      expect((await router.executeSurfaceNeutralTurn(input() as any)).text).toBe("grok answer");
      expect(calls).toEqual(["codex", "grok"]);
    } finally { db.close(); }
  });

  it("fails clearly without invoking any provider when none is routeable", async () => {
    const { db, router, calls } = routerWith(["codex", "claude"], () => new Set());
    try {
      await expect(router.executeSurfaceNeutralTurn(input() as any)).rejects.toThrow(/no available provider/);
      expect(calls).toEqual([]);
    } finally { db.close(); }
  });

  it("never advertises an unavailable head as nextProvider before the first turn (#1114)", () => {
    const { router } = routerWith(["codex", "claude"], () => new Set(["claude"]));
    // No turn has executed yet for this chat — codex (the configured head)
    // is unavailable. A status/list read must not advertise an unroutable
    // provider as what the next turn will use.
    expect(router.activeProvider("autonomous:episode-1")).toBe("claude");
  });

  it("does not loop on an exhausted chain", async () => {
    const { db, router, calls } = routerWith(
      ["codex", "claude"],
      () => new Set(["codex", "claude"]),
      { codex: new Error("usage limit reached"), claude: new Error("usage limit reached") },
    );
    try {
      await expect(router.executeSurfaceNeutralTurn(input() as any)).rejects.toThrow(/usage limit/);
      expect(calls).toEqual(["codex", "claude"]);
    } finally { db.close(); }
  });

  it("a concurrent read-only status peek does not cause fallback to skip the failed provider's successor (#1114 P0)", async () => {
    // Reproduces the Desk regression: a status/list poll calls
    // router.activeProvider() (read-only by contract) while codex is still
    // executing. If that peek mutates shared per-chat routing state, the
    // subsequent capacity failure advances from the peek's mutated index
    // instead of from codex's own attempt, and skips claude entirely.
    let codexAvailable = true;
    const chatKey = "autonomous:episode-1";
    const { db, router, calls } = routerWith(
      ["codex", "claude"],
      () => new Set(["codex", "claude"].filter((provider) => provider !== "codex" || codexAvailable)),
      { codex: new Error("usage limit reached") },
      (provider) => {
        if (provider === "codex") {
          codexAvailable = false;
          router.activeProvider(chatKey);
        }
      },
    );
    try {
      expect((await router.executeSurfaceNeutralTurn(input() as any)).text).toBe("claude answer");
      expect(calls).toEqual(["codex", "claude"]);
    } finally { db.close(); }
  });
});
