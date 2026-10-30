/**
 * Slack capacity-wait parity (#1114 Phase 3): Telegram and Discord already
 * hold the original admission and durably wait when every configured
 * provider is at capacity (#1010). Slack's entrypoint omitted
 * capacityFallbackAttempts wiring and the capacityWait continuation branch
 * entirely, so a Slack chat whose providers were all at capacity would fail
 * outright instead of waiting. This exercises the exact same durable-wait
 * cycle through Slack-shaped identifiers (channel:thread-ts chatKey,
 * chatType "channel") using the shared onProviderFallbackRequested hook
 * factory Slack's entrypoint now wires in place of a bespoke handler.
 */
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchClaimedInteractiveWithFallback, dispatchInteractiveTurnWithFallback, resumeCapacityHeldQueue, type CliKind } from "../src/interactiveBot.js";
import { listRunContinuations } from "../src/runContinuation.js";
import { createCapacityFallbackRequestedHook } from "../src/providers/capacityFallbackHook.js";

// Claude (and, by shared ACP transport, Codex) resolve to ACP-stdio by
// default; adapt the injected runCli fakes so each engine's simulated CLI
// still governs its own transport regardless (mirrors interactiveCapacityFallback.test.ts).
function extractStreamDeltaText(chunk: string): string | null {
  try {
    const obj = JSON.parse(chunk.trim());
    return obj?.event?.delta?.text ?? null;
  } catch {
    return null;
  }
}

function extractResultText(stdout: string): string {
  try {
    const obj = JSON.parse(stdout);
    if (typeof obj?.result === "string") return obj.result;
  } catch {
    // not JSON — use the raw stdout as-is.
  }
  return stdout;
}

function asAcpAdapter(runCli: any) {
  return async (_bot: string, invocation: any, cwd: string, options: any) => {
    const bridgedOptions = {
      ...options,
      onProviderOutputChunk: (chunk: string) => {
        options.onProviderOutputChunk?.(chunk);
        const delta = extractStreamDeltaText(chunk);
        if (delta) options.onAnswerDelta?.(delta);
      },
    };
    const stdout = await runCli(invocation.command, invocation.args, cwd, bridgedOptions);
    return { text: extractResultText(stdout) };
  };
}

function makeSlackClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("Slack capacity-wait parity (#1114)", () => {
  it("holds the original Slack thread admission and resumes it once a provider recovers", async () => {
    const db = openDb(":memory:");
    const client = makeSlackClient();
    const surfaceIdentity = "slack:interactive";
    const chatKey = "C100:1700000000.000100"; // channel:thread-ts, as Slack threads are keyed
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, surfaceIdentity, () => true);
    const fallbackRequests = new Map<string, import("../src/engine.js").ProviderFallbackReason>();
    const capacityFallbackAttempts = new Map<string, { runId: string; chatId: number | string; chatType: string; threadId?: number | string; provider?: CliKind; retryAfterSeconds?: number; hasUnknownCapacityTiming?: true }>();
    const notifications: string[] = [];

    const codexRun = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
    const claudeRun = vi.fn()
      .mockRejectedValueOnce(new Error("MODEL_CAPACITY_EXHAUSTED"))
      .mockResolvedValue(JSON.stringify({ result: "claude has recovered" }));
    const makeEngine = (kind: "codex" | "claude", runCli: typeof codexRun) => new BridgeEngine(
      {
        surfaceIdentity,
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["U1"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1_000,
        hooks: {
          onProviderFallbackRequested: createCapacityFallbackRequestedHook(kind, {
            fallbackRequests,
            capacityFallbackAttempts,
          }),
        },
      },
      db,
      client,
      { runCli: runCli as any, runProviderInvocation: asAcpAdapter(runCli) },
    );
    const engines = { codex: makeEngine("codex", codexRun), claude: makeEngine("claude", claudeRun) };
    const deps = {
      surfaceIdentity,
      engines,
      fallbackChain,
      fallbackRequests,
      capacityFallbackAttempts,
      db,
      notify: async (message: string) => { notifications.push(message); },
    };

    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      await dispatchInteractiveTurnWithFallback({
        surfaceIdentity,
        chatKey,
        actorId: "U1",
        messageId: "1",
        text: "keep this exact Slack thread request",
        threadId: "1700000000.000100",
        delivery: { chatId: "C100", chatType: "channel" },
        attachments: [],
      }, deps);

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(notifications).toEqual([
        "All available providers are temporarily at capacity. I’ll retry automatically and continue your task when one becomes available.",
      ]);

      const continuations = listRunContinuations(db, surfaceIdentity);
      expect(continuations).toEqual([
        expect.objectContaining({ state: "pending", capacityWait: true, provider: "claude", chatKey }),
      ]);
      // Slack thread coordinates must survive into the durable wait record —
      // this is the "lossless thread coordinates" parity requirement.
      expect(continuations[0].delivery).toMatchObject({ chatId: "C100", chatType: "channel", threadId: "1700000000.000100" });

      // Provider recovers before the scheduled scan is due: resumeCapacityHeldQueue
      // (the same function RunContinuationRunner's capacityWait branch calls)
      // must be able to drain and retry the retained Slack admission directly.
      const recovered = await resumeCapacityHeldQueue(continuations[0], { engines, fallbackChain, db });

      // A claimed-message resume re-enters dispatch with a fresh tried set, so
      // it restarts from the chat's stored CLI preference (codex, the
      // default here) rather than resuming mid-chain at claude — the same
      // behaviour the existing Telegram/Discord capacity-wait resume already
      // exercises. Codex fails again (still exhausted), falls back to claude,
      // which has now recovered.
      expect(recovered).toBe(true);
      expect(codexRun).toHaveBeenCalledTimes(2);
      expect(claudeRun).toHaveBeenCalledTimes(2);
      expect(db.pendingMsgCount(surfaceIdentity, chatKey)).toBe(0);
    } finally {
      db.close();
    }
  });
});
