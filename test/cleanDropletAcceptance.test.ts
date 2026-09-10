import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import type { TelegramMessage } from "../src/types.js";

const runProviderInvocationMock = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli.js")>();
  return { ...actual, runProviderInvocation: runProviderInvocationMock };
});

function makeMessage(text: string): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

function makeClient() {
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
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 2 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("clean-droplet acceptance", () => {
  it("starts the first Codex turn through ACP with no resume session after database startup", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    process.env.CODEX_ACP_COMMAND = "codex-acp";
    runProviderInvocationMock.mockReset();
    runProviderInvocationMock.mockResolvedValue({
      text: "ok",
      sessionId: "acp-fresh-session",
      stopReason: "end_turn",
    });
    const db = openDb(":memory:");
    try {
      const { BridgeEngine } = await import("../src/engine.js");
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "clean-appliance",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "trusted",
          pollIntervalMs: 1000,
        },
        db,
        makeClient(),
      );

      await engine.handleMessages([makeMessage("first request on a new appliance")]);

      expect(runProviderInvocationMock).toHaveBeenCalledTimes(1);
      expect(runProviderInvocationMock.mock.calls[0]?.[1]).toMatchObject({
        transport: "acp-stdio",
        command: "codex-acp",
      });
      expect(runProviderInvocationMock.mock.calls[0]?.[4]).toMatchObject({
        sessionId: null,
        command: "codex-acp",
        executionMode: "trusted",
      });
      expect(db.getAcpSessionBinding("100", "codex")?.acpSessionId).toBe("acp-fresh-session");
    } finally {
      db.raw.close();
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
    }
  });
});
