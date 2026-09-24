import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import {
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveWithFallback,
  setUserCliPreference,
} from "../src/interactiveBot.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

// Mirrors test/interactiveCapacityFallback.test.ts's ACP-adapter bridging:
// claude/codex resolve to ACP-stdio transport, driven through
// exec.runProviderInvocation rather than exec.runCli.
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
    // not JSON -- use the raw stdout as-is.
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

function makeMockClient() {
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("Codex in-band systemError capacity wording falls back instead of dead-ending", () => {
  it("falls back to the next CLI when Codex reports 'Selected model is at capacity'", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, () => true);
    const notifications: string[] = [];
    const fallbackRequests = new Map<string, import("../src/engine.js").ProviderFallbackReason>();

    // The exact in-band system-error wording observed in production
    // (src/acp/client.ts's AcpSystemError, thrown from a `threadStatus.type
    // === "systemError"` notification -- not an HTTP 429/quota response).
    const codexRun = vi.fn().mockRejectedValue(
      new Error("Selected model is at capacity. Please try a different model."),
    );
    const claudeRun = vi.fn().mockResolvedValue(
      JSON.stringify({ event: "result", result: { conversation_id: "11111111-2222-4333-8444-555555555555", status: "SUCCESS", response: "authoritative Claude fallback" } }),
    );

    const makeEngine = (kind: "codex" | "claude", runCli: any) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1000,
        hooks: {
          onProviderFallbackRequested: async (chatKey: string, reason: import("../src/engine.js").ProviderFallbackReason) => {
            fallbackRequests.set(chatKey, reason);
          },
        },
      },
      db,
      client,
      { runCli, runProviderInvocation: asAcpAdapter(runCli) },
    );
    const engines = { codex: makeEngine("codex", codexRun), claude: makeEngine("claude", claudeRun) };
    const deps = { engines, fallbackChain, fallbackRequests, db, notify: async (message: string) => { notifications.push(message); } };

    try {
      setUserCliPreference(db, "100", "codex");
      for (const engine of Object.values(engines)) {
        engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      }

      await dispatchInteractiveWithFallback({
        update_id: 9100,
        message: { message_id: 88, chat: { id: 100, type: "private" }, from: { id: 42, first_name: "Test" }, text: "answer this" },
      }, "100", deps);

      // Tier 2 (#877) retries codex once on a fresh session before falling
      // back to the next CLI; both codex attempts fail here (the mock always
      // rejects), so it still ends up on claude.
      expect(codexRun).toHaveBeenCalledTimes(2);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls.at(-1)?.[0]?.text).toContain("authoritative Claude fallback");
      expect(notifications).toEqual(["Switching to claude after codex became unavailable."]);
    } finally {
      db.close();
    }
  });
});
