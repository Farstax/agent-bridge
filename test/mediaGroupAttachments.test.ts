import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";

function codexResult(text = "done", sessionId = "session-1"): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  ].join("\n");
}

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn(),
    sendDocument: vi.fn(),
    getUpdates: vi.fn(),
    setMyCommands: vi.fn(),
    answerCallbackQuery: vi.fn(),
    editMessageText: vi.fn(),
    getFilePath: vi.fn(async (fileId: string) => `remote/${fileId}`),
    downloadFile: vi.fn(async (remotePath: string, localPath: string) => {
      await writeFile(localPath, remotePath, "utf8");
    }),
  } as any;
}

function engine(db: any, c: any, runCli: any, busyMessageMode: "augment" | "interrupt" | "queue" = "queue") {
  return new BridgeEngine({
    surfaceIdentity: "telegram:interactive",
    kind: "codex",
    botConfig: { command: "codex", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe",
    busyMessageMode,
    pollIntervalMs: 1,
  }, db, c, { runCli });
}

function album(caption = "review album") {
  return [
    {
      message_id: 10,
      media_group_id: "album-1",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
      message_thread_id: 7,
      photo: [{ file_id: "photo-id", file_unique_id: "photo-u", width: 100, height: 100 }],
    },
    {
      message_id: 11,
      media_group_id: "album-1",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
      message_thread_id: 7,
      caption,
      document: {
        file_id: "doc-id",
        file_unique_id: "doc-u",
        file_name: "notes.txt",
        mime_type: "text/plain",
      },
    },
  ] as any[];
}

function attachmentArgs(runCli: any, callIndex = 0): string[] {
  const args = runCli.mock.calls[callIndex][1] as string[];
  const paths: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "-i") paths.push(args[i + 1]);
  }
  return paths;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Telegram media group attachment ownership", () => {
  it("passes every supported album attachment to execution in message order and cleans the run directory", async () => {
    const db = openDb(":memory:");
    const c = client();
    const runCli = vi.fn().mockResolvedValue(codexResult());
    const subject = engine(db, c, runCli);

    await subject.handleMessages(album());

    expect(c.getFilePath.mock.calls.map((call: any[]) => call[0])).toEqual(["photo-id", "doc-id"]);
    expect(runCli).toHaveBeenCalledOnce();
    const paths = attachmentArgs(runCli);
    expect(paths.map((value) => basename(value).replace(/^attachment-\d+-/, ""))).toEqual([
      "photo_photo-id.jpg",
      "notes.txt",
    ]);
    expect(paths).toHaveLength(2);
    expect(paths.every((value) => !existsSync(value))).toBe(true);
    db.close();
  });

  it("fails the whole album instead of executing with an incomplete attachment set", async () => {
    const db = openDb(":memory:");
    const c = client();
    c.downloadFile.mockImplementation(async (remotePath: string, localPath: string) => {
      if (remotePath.endsWith("doc-id")) throw new Error("download failed");
      await writeFile(localPath, remotePath, "utf8");
    });
    const runCli = vi.fn().mockResolvedValue(codexResult());
    const subject = engine(db, c, runCli);

    await subject.handleMessages(album());

    expect(c.getFilePath.mock.calls.map((call: any[]) => call[0])).toEqual(["photo-id", "doc-id"]);
    expect(runCli).not.toHaveBeenCalled();
    expect(c.sendMessage.mock.calls.some((call: any[]) => /could not download all attachments/i.test(call[0]?.text ?? ""))).toBe(true);
    db.close();
  });

  it("keeps every queued album file until the queued execution owns and completes it", async () => {
    const db = openDb(":memory:");
    const c = client();
    let releaseFirst!: (value: string) => void;
    const firstResult = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const runCli = vi.fn()
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValueOnce(codexResult("album done", "session-2"));
    const subject = engine(db, c, runCli, "queue");

    const first = subject.handleMessages([{
      message_id: 1,
      chat: { id: 100, type: "private" },
      from: { id: 42 },
      message_thread_id: 7,
      text: "first",
    } as any]);
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledOnce());

    await subject.handleMessages(album("queued album"));
    expect(runCli).toHaveBeenCalledOnce();
    const queued = db.dequeueMsgs("telegram:interactive", "100:7").find((row) => row.prompt === "queued album");
    expect(queued).toBeDefined();
    expect(queued!.attachments).toHaveLength(2);
    expect(queued!.attachments.every((value) => existsSync(value))).toBe(true);

    const retainedPaths = [...queued!.attachments];
    releaseFirst(codexResult("first done", "session-1"));
    await first;

    expect(runCli).toHaveBeenCalledTimes(2);
    expect(attachmentArgs(runCli, 1)).toEqual(retainedPaths);
    expect(retainedPaths.every((value) => !existsSync(value))).toBe(true);
    db.close();
  });
});
