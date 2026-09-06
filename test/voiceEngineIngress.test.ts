import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import type { InteractiveTurnInput } from "../src/interactiveIngress.js";

const prepareVoice = vi.hoisted(() => vi.fn());
vi.mock("../src/voiceIngress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/voiceIngress.js")>();
  return { ...actual, prepareVoiceBatchForDispatch: prepareVoice };
});

import { BridgeEngine } from "../src/engine.js";
import { executionLaneCoordinator } from "../src/executionLaneCoordinator.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function audioTurn(messageId = "voice-1"): InteractiveTurnInput {
  return {
    surfaceIdentity: "telegram:interactive",
    chatKey: "100",
    actorId: "42",
    messageId,
    text: "",
    delivery: { chatId: 100, chatType: "private" },
    attachments: [{
      kind: "audio",
      fileId: "voice-file",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      fileSize: 100,
      durationSeconds: 5,
    }],
  };
}

function stopTurn(messageId = "stop-1"): InteractiveTurnInput {
  return {
    surfaceIdentity: "telegram:interactive",
    chatKey: "100",
    actorId: "42",
    messageId,
    text: "/stop",
    delivery: { chatId: 100, chatType: "private" },
    attachments: [],
  };
}

function preparedTurns(turns: InteractiveTurnInput[]) {
  return {
    kind: "ready" as const,
    turns: turns.map((turn, index) => index === 0 ? { ...turn, text: "ordinary transcript", attachments: [] } : turn),
  };
}

function makeMockClient() {
  return {
    capabilities: {
      maxMessageLength: 4096,
      editMessages: true,
      deleteMessages: true,
      previewStreaming: true,
      threads: true,
      attachments: true,
      typing: true,
      polling: true,
      remoteFileDownload: true,
      richMessages: true,
      passiveSurroundingContext: false,
      formatting: "telegram-html",
    },
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

describe("voice ingress -> ordinary Run admission fence", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    prepareVoice.mockReset();
    dbPath = join(tmpdir(), `voice-engine-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  function makeEngine(options: { onBeforeExecute?: (prompt: string) => Promise<string> } = {}) {
    const runCli = vi.fn().mockResolvedValue("provider result");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
        hooks: options.onBeforeExecute ? { onBeforeExecute: options.onBeforeExecute } : undefined,
      },
      db,
      client,
      { runCli },
    );
    return { engine, runCli, client };
  }

  async function assertStopBeforePreparationRelease(phase: "download" | "transcription") {
    const started = deferred();
    const release = deferred();
    prepareVoice.mockImplementationOnce(async (turns: InteractiveTurnInput[], options: { signal: AbortSignal }) => {
      started.resolve();
      await release.promise;
      return options.signal.aborted ? { kind: "drop" } : preparedTurns(turns);
    });
    const { engine, runCli } = makeEngine();
    const admit = vi.spyOn(db, "admitMessage");

    const pending = engine.handleInteractiveTurn(audioTurn(`${phase}-voice`));
    await started.promise;
    await engine.handleInteractiveTurn(stopTurn(`${phase}-stop`));
    release.resolve();
    await pending;

    expect(admit, `${phase} must not reach durable ordinary Run admission`).not.toHaveBeenCalled();
    expect(runCli, `${phase} must not start a provider`).not.toHaveBeenCalled();
    const coordinator = executionLaneCoordinator(db, "telegram:interactive");
    expect(coordinator.preProviderIngressCount()).toBe(0);
  }

  it("stop while audio download is held -> release -> zero Run/provider admission", async () => {
    await assertStopBeforePreparationRelease("download");
  });

  it("stop while transcription is held -> release -> zero Run/provider admission", async () => {
    await assertStopBeforePreparationRelease("transcription");
  });

  it("stop at the exact STT-to-Run handoff -> zero Run/provider admission", async () => {
    prepareVoice.mockImplementationOnce(async (turns: InteractiveTurnInput[]) => preparedTurns(turns));
    const hookStarted = deferred();
    const releaseHook = deferred();
    const { engine, runCli } = makeEngine({
      onBeforeExecute: async (prompt) => {
        hookStarted.resolve();
        await releaseHook.promise;
        return prompt;
      },
    });
    const admit = vi.spyOn(db, "admitMessage");

    const pending = engine.handleInteractiveTurn(audioTurn("handoff-voice"));
    await hookStarted.promise;
    await engine.handleInteractiveTurn(stopTurn("handoff-stop"));
    releaseHook.resolve();
    await pending;

    expect(admit).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    expect(executionLaneCoordinator(db, "telegram:interactive").preProviderIngressCount()).toBe(0);
  });

  it("claims the pre-provider scope before durable admission so later stop is no longer ingress-owned", async () => {
    prepareVoice.mockImplementationOnce(async (turns: InteractiveTurnInput[]) => preparedTurns(turns));
    const { engine } = makeEngine();
    const coordinator = executionLaneCoordinator(db, "telegram:interactive");
    const originalAdmit = db.admitMessage.bind(db);
    let countAtAdmission = -1;
    vi.spyOn(db, "admitMessage").mockImplementation(((...args: Parameters<typeof db.admitMessage>) => {
      countAtAdmission = coordinator.preProviderIngressCount();
      return originalAdmit(...args);
    }) as typeof db.admitMessage);

    await engine.handleInteractiveTurn(audioTurn("claimed-voice"));

    expect(countAtAdmission).toBe(0);
    expect(coordinator.preProviderIngressCount()).toBe(0);
  });

  it("forwards the original attachment through the ordinary attachment path on a real transcription failure", async () => {
    const turn = audioTurn("retain-voice");
    prepareVoice.mockImplementationOnce(async (turns: InteractiveTurnInput[], options: { retainAttachment?: (turn: InteractiveTurnInput, filePath: string, attachment: unknown) => Promise<void> }) => {
      await options.retainAttachment?.(turns[0], "/tmp/fake-retained-audio.ogg", turns[0].attachments[0]);
      return { kind: "drop" as const };
    });
    const { engine, runCli, client } = makeEngine();
    const admit = vi.spyOn(db, "admitMessage");

    await engine.handleInteractiveTurn(turn);

    expect(admit).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    expect(client.sendDocument).toHaveBeenCalledWith(100, "/tmp/fake-retained-audio.ogg", undefined, undefined);
  });
});
