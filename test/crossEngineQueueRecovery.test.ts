import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { isAbortRequested } from "../src/cliSupervisor.js";
import {
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveWithFallback,
  setUserCliPreference,
} from "../src/interactiveBot.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";

const SURFACE = "telegram:interactive";

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function makeEngine(
  kind: "codex" | "claude",
  db: ReturnType<typeof openDb>,
  client: ReturnType<typeof makeMockClient>,
  runCli: ReturnType<typeof vi.fn>,
) {
  return new BridgeEngine(
    {
      kind,
      surfaceIdentity: SURFACE,
      botConfig: { command: kind, modelPreference: ["test-model"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "augment",
      pollIntervalMs: 1000,
    },
    db,
    client,
    { runCli: runCli as any },
  );
}

function update(messageId: number, text: string) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      chat: { id: 100, type: "private" },
      from: { id: 42, first_name: "Operator" },
      text,
    },
  } as any;
}

function claudeResult(text: string, sessionId: string) {
  return JSON.stringify({ type: "result", session_id: sessionId, result: text });
}

function wireInteractiveQueue(
  engines: Record<"codex" | "claude", BridgeEngine>,
  deps: any,
) {
  for (const engine of Object.values(engines)) {
    engine.setQueuedMessageHandler(async (queued) =>
      dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for test condition");
}

describe("cross-engine queue recovery", () => {
  it("does not poison the next live message after default-engine recovery executes on the preferred engine", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const recoveryRun = vi.fn().mockRejectedValue(new Error("default recovery engine must not execute the claimed turn"));
    const preferredRun = vi.fn()
      .mockResolvedValueOnce(claudeResult("recovered", "session-recovered"))
      .mockResolvedValueOnce(claudeResult("live", "session-live"));
    const engines = {
      codex: makeEngine("codex", db, client, recoveryRun),
      claude: makeEngine("claude", db, client, preferredRun),
    };
    const deps = {
      engines,
      fallbackChain: new ProviderFallbackChain(["codex", "claude"], db),
      exhaustedChats: new Set<string>(),
      db,
      notify: vi.fn(),
    };
    wireInteractiveQueue(engines, deps);

    try {
      setUserCliPreference(db, "100", "claude");
      db.enqueueMsg(SURFACE, "100", {
        prompt: "recovered work",
        chatId: 100,
        chatType: "private",
        userId: 42,
      });

      await engines.codex.recoverPendingQueues();

      expect(recoveryRun).not.toHaveBeenCalled();
      expect(preferredRun).toHaveBeenCalledTimes(1);
      expect(db.pendingMsgCount(SURFACE, "100")).toBe(0);

      await dispatchInteractiveWithFallback(update(2, "new live work"), "100", deps);

      expect(preferredRun).toHaveBeenCalledTimes(2);
      expect(db.pendingMsgCount(SURFACE, "100")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("preserves augment progress when a live message arrives during cross-engine recovered execution", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const recoveryRun = vi.fn().mockRejectedValue(new Error("default recovery engine must not execute the claimed turn"));
    let markStarted!: () => void;
    let finishFirst!: (value: string) => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstResult = new Promise<string>((resolve) => { finishFirst = resolve; });
    const preferredRun = vi.fn()
      .mockImplementationOnce(async () => {
        markStarted();
        return firstResult;
      })
      .mockResolvedValueOnce(claudeResult("combined successor", "session-successor"));
    const engines = {
      codex: makeEngine("codex", db, client, recoveryRun),
      claude: makeEngine("claude", db, client, preferredRun),
    };
    const deps = {
      engines,
      fallbackChain: new ProviderFallbackChain(["codex", "claude"], db),
      exhaustedChats: new Set<string>(),
      db,
      notify: vi.fn(),
    };
    wireInteractiveQueue(engines, deps);

    try {
      setUserCliPreference(db, "100", "claude");
      db.enqueueMsg(SURFACE, "100", {
        prompt: "recovered work",
        chatId: 100,
        chatType: "private",
        userId: 42,
      });

      const recovery = engines.codex.recoverPendingQueues();
      await firstStarted;

      const live = dispatchInteractiveWithFallback(update(3, "augment this work"), "100", deps);
      const executionLane = JSON.stringify([SURFACE, "100"]);
      await waitFor(() => isAbortRequested(executionLane));
      finishFirst(claudeResult("superseded recovered result", "session-first"));

      await Promise.all([recovery, live]);

      expect(preferredRun).toHaveBeenCalledTimes(2);
      const providerPrompts = preferredRun.mock.calls.map(([, args]) => {
        const argv = args as string[];
        return argv.at(-1) ?? "";
      });
      expect(providerPrompts).toHaveLength(2);
      expect(providerPrompts[0]).toContain("recovered work");
      expect(providerPrompts[1]).toContain("recovered work\n\naugment this work");
      expect(db.pendingMsgCount(SURFACE, "100")).toBe(0);
    } finally {
      db.close();
    }
  });
});
