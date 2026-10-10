import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchClaimedInteractiveWithFallback, dispatchInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import { attachProviderFailureEvidence } from "../src/providers/failureEvidence.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

function client() {
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

async function run(failure: () => Error) {
  const db = openDb(":memory:");
  const telegram = client();
  const prompts: string[] = [];
  let failing = true;
  const runProviderInvocation = vi.fn(async (_k: string, _i: any, _c: string, _o: any, request: any) => {
    prompts.push(String(request.prompt));
    if (failing) throw failure();
    return { text: "ok", sessionId: "s", stopReason: "end_turn" };
  });
  const engine = new BridgeEngine({
    surfaceIdentity: "telegram:interactive",
    kind: "codex",
    botConfig: { command: "codex", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe",
    busyMessageMode: "augment",
    pollIntervalMs: 1000,
    workingDir: process.cwd(),
  }, db, telegram, { runProviderInvocation } as any);
  const deps: any = {
    engines: { codex: engine },
    fallbackChain: new ProviderFallbackChain(["codex"], db, "telegram:interactive", () => true),
    fallbackRequests: new Map(),
    db,
    notify: async () => {},
  };
  engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
  setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "977" }, "codex");
  const send = (id: number, text: string) => dispatchInteractiveWithFallback({
    update_id: id,
    message: { message_id: id, chat: { id: 977, type: "private" }, from: { id: 42, first_name: "T" }, text },
  }, "977", deps);
  await send(1, "FIRST-TASK do the risky thing");
  const afterFirst = { pending: db.pendingMsgCount("telegram:interactive", "977"), runs: db.raw.prepare("select status, error from bridge_runs").all() as any[] };
  failing = false;
  await send(2, "SECOND-MESSAGE hello");
  return { db, prompts, afterFirst, runProviderInvocation };
}

describe("a failed task whose error was delivered in place is retired, not replayed", () => {
  it("does not re-run an ambiguous post-submission failure with the next message", async () => {
    const { db, prompts, afterFirst } = await run(() =>
      attachProviderFailureEvidence(new Error("Internal error: connection lost after submission"), { promptSubmitted: true }));
    try {
      expect(afterFirst.pending).toBe(0);
      expect(afterFirst.runs.map((r) => r.status)).toEqual(["failed"]);
      const replays = prompts.filter((p, index) => index > 0 && p.includes("FIRST-TASK"));
      expect(replays).toEqual([]);
    } finally { db.close(); }
  });
});
