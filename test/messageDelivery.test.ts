import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { sendTelegramMessage, sendMessageWithProgress } from "../src/messageDelivery.js";
import type { TelegramClient } from "../src/telegram.js";
import type { CliResult } from "../src/types.js";
import * as telegramAdapter from "../src/events/telegramAdapter.js";

const createMockClient = () => ({
  sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 456, ...body } })),
  sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
  editMessageText: vi.fn(async () => ({ ok: true, result: true })),
  deleteMessage: vi.fn(async () => ({ ok: true, result: true })),
  sendMessageDraft: vi.fn(async () => ({ ok: true })),
} as any as TelegramClient);

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe("sendMessageWithProgress", () => {
  it("creates one safe preview from answer deltas and reconciles it with the final result", async () => {
    const client = createMockClient();
    await sendMessageWithProgress({
      client,
      kind: "claude",
      chatId: 123,
      execution: async (_onProgress, onAnswerDelta) => {
        onAnswerDelta?.("*safe");
        onAnswerDelta?.(" answer*");
        return { text: "*safe answer*", sessionId: "s1" } as CliResult;
      },
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chat_id: 123 }));
    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      message_id: 456,
      text: expect.stringContaining("safe answer"),
    }));
  });

  it("keeps final-only delivery when preview editing fails", async () => {
    const client = createMockClient();
    client.editMessageText.mockRejectedValue(new Error("preview edit failed"));
    await sendMessageWithProgress({
      client,
      kind: "claude",
      chatId: 123,
      execution: async (_onProgress, onAnswerDelta) => {
        onAnswerDelta?.("safe preview");
        return { text: "authoritative final", sessionId: "s1" } as CliResult;
      },
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1][0]).toEqual(expect.objectContaining({ text: expect.stringContaining("authoritative final") }));
  });

  it("removes a Claude preview before propagating an abandoned execution error", async () => {
    const client = createMockClient();
    client.deleteMessage = vi.fn(async () => ({ ok: true }));

    await expect(sendMessageWithProgress({
      client,
      kind: "claude",
      chatId: 123,
      propagateExecutionErrors: true,
      execution: async (_onProgress, onAnswerDelta) => {
        onAnswerDelta?.("abandoned answer");
        throw new Error("provider execution failed");
      },
    })).rejects.toThrow("provider execution failed");

    expect(client.deleteMessage).toHaveBeenCalledWith({ chat_id: 123, message_id: 456 });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not delete the authoritative preview after final delivery", async () => {
    const client = createMockClient();
    const afterFinalDelivery = vi.fn(async () => { throw new Error("post-delivery hook failed"); });

    await sendMessageWithProgress({
      client,
      kind: "claude",
      chatId: 123,
      afterFinalDelivery,
      execution: async (_onProgress, onAnswerDelta) => {
        onAnswerDelta?.("authoritative answer");
        return { text: "authoritative answer", sessionId: "s1" } as CliResult;
      },
    });

    expect(afterFinalDelivery).toHaveBeenCalledTimes(1);
    expect(client.deleteMessage).not.toHaveBeenCalled();
  });

  it("keeps Codex final-only even when a caller supplies answer-like deltas", async () => {
    const client = createMockClient();
    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: async (_onProgress, onAnswerDelta) => {
        onAnswerDelta?.("must remain final-only");
        return { text: "authoritative Codex answer", sessionId: "s1" } as CliResult;
      },
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.editMessageText).not.toHaveBeenCalled();
  });

  it("does not publish a preview or final result after fencing", async () => {
    const client = createMockClient();
    let aborted = false;
    await sendMessageWithProgress({
      client,
      kind: "claude",
      chatId: 123,
      isAborted: () => aborted,
      execution: async (_onProgress, onAnswerDelta) => {
        onAnswerDelta?.("partial answer");
        aborted = true;
        return { text: "authoritative final", sessionId: "s1" } as CliResult;
      },
    });

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.editMessageText).not.toHaveBeenCalled();
  });

  it("suppresses final delivery when the execution fence rejects publication", async () => {
    const client = createMockClient();
    const result = await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: "stale result", sessionId: "s1" }),
      beforeFinalDelivery: () => false,
    });
    expect(result).toBeNull();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send a thinking placeholder for codex", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({ client, kind: "codex", chatId, execution });

    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: chatId, text: "🤔 Thinking..." })
    );
  });

  it("does not send a thinking placeholder for antigravity", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({ client, kind: "antigravity", chatId, execution });

    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: chatId, text: "🤔 Thinking..." })
    );
  });

  it("sends sanitized STATUS progress when antigravity narration visibility is enabled", async () => {
    const sent: string[] = [];
    const edits: string[] = [];
    const client = {
      sendMessage: vi.fn(async (body: any) => { sent.push(body.text); return { ok: true, result: { message_id: 99, ...body } }; }),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async (body: any) => { edits.push(body.text); return { ok: true }; }),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;

    await sendMessageWithProgress({
      client,
      kind: "antigravity",
      chatId: 123,
      showProgressNarration: true,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress("STATUS: chunk1\n");
        onProgress("STATUS: chunk2\n");
        return Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);
      },
    });

    expect(sent.some((t) => t.includes("chunk1"))).toBe(true);
    expect(sent.some((t) => t.includes("🤔 Thinking"))).toBe(false);
  });

  it("hides antigravity progress narration when narration visibility is disabled", async () => {
    const client = createMockClient();

    await sendMessageWithProgress({
      client,
      kind: "antigravity",
      chatId: 123,
      showProgressNarration: false,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress("I will inspect files.\nSTATUS: reading files\n");
        return Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);
      },
    });

    const editTexts = (client.editMessageText as any).mock.calls.map((call: any[]) => call[0]?.text ?? "");
    expect(editTexts.some((text: string) => text.includes("reading files"))).toBe(false);
    expect(editTexts.some((text: string) => text.includes("I will inspect files"))).toBe(false);
    expect(client.sendChatAction).toHaveBeenCalledWith(expect.objectContaining({ chat_id: 123, action: "typing" }));
  });

  it("shows only sanitized STATUS lines when antigravity narration visibility is enabled", async () => {
    const client = createMockClient();

    await sendMessageWithProgress({
      client,
      kind: "antigravity",
      chatId: 123,
      showProgressNarration: true,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress("I will inspect files.\nSTATUS: reading files\nSTATUS: running tests\n");
        return Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);
      },
    });

    const allTexts = [
      ...(client.sendMessage as any).mock.calls.map((call: any[]) => call[0]?.text ?? ""),
      ...(client.editMessageText as any).mock.calls.map((call: any[]) => call[0]?.text ?? ""),
    ];
    expect(allTexts.some((text: string) => text.includes("reading files"))).toBe(true);
    expect(allTexts.some((text: string) => text.includes("running tests"))).toBe(true);
    expect(allTexts.some((text: string) => text.includes("I will inspect files"))).toBe(false);
  });

  it("preserves markdown formatting when editing an antigravity progress message into the final answer", async () => {
    const client = createMockClient();

    await sendMessageWithProgress({
      client,
      kind: "antigravity",
      chatId: 123,
      showProgressNarration: true,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress("STATUS: running tests\n");
        return Promise.resolve({ text: "**Done** run `npm test`", sessionId: "s1" } as CliResult);
      },
    });

    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      message_id: 456,
      parse_mode: "HTML",
      text: "<b>Done</b> run <code>npm test</code>",
    }));
  });

  it("does not re-send an unchanged STATUS preview on a later tick (dedup)", async () => {
    const dateSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    dateSpy.mockImplementation(() => now);

    const client = createMockClient();

    await sendMessageWithProgress({
      client,
      kind: "antigravity",
      chatId: 123,
      showProgressNarration: true,
      execution: async (onProgress: (chunk: string) => void) => {
        onProgress("STATUS: running tests\n");
        await new Promise((r) => setTimeout(r, 0));
        now += 6000;
        // No new STATUS line — extracted preview text is identical to the last tick.
        onProgress("more reasoning, no new STATUS line\n");
        await new Promise((r) => setTimeout(r, 0));
        return { text: "Final answer", sessionId: "s1" } as CliResult;
      },
    });

    dateSpy.mockRestore();

    const previewEdits = (client.editMessageText as any).mock.calls.filter(
      (call: any[]) => call[0]?.text === "running tests"
    );
    expect(previewEdits.length).toBe(0);
  });

  it("delivers final text to Telegram for a resolved-promise execution", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    await sendMessageWithProgress({ client, kind: "codex", chatId, execution });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: chatId, text: "Final answer" })
    );
  });

  it("returns only CliResult fields (text, sessionId) — no onProgress on returned object", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.resolve({ text: "Final answer", sessionId: "s1" } as CliResult);

    const result = await sendMessageWithProgress({ client, kind: "codex", chatId, execution });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("onProgress");
    expect(result).toEqual({ text: "Final answer", sessionId: "s1" });
  });

  it("returns only CliResult fields when execution is a function — no onProgress on returned object", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = async (onProgress: (chunk: string) => void) => {
      onProgress("chunk");
      return { text: "Answer from fn", sessionId: "s2" } as CliResult;
    };

    const result = await sendMessageWithProgress({ client, kind: "codex", chatId, execution });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("onProgress");
    expect(result).toEqual({ text: "Answer from fn", sessionId: "s2" });
  });

  it("strips undeclared onProgress from the returned CliResult shape", async () => {
    const client = createMockClient();
    const chatId = 123;
    const leakedOnProgress = vi.fn();
    const execution = async () => ({
      text: "Answer with runtime extra",
      sessionId: "s3",
      onProgress: leakedOnProgress,
    });

    const result = await sendMessageWithProgress({ client, kind: "codex", chatId, execution });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("onProgress");
    expect(result).toEqual({ text: "Answer with runtime extra", sessionId: "s3" });
  });

  it("handles execution as a function and passes onProgress", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = vi.fn(async (onProgress: any) => {
      onProgress("chunk1");
      return { text: "Final answer", sessionId: "s1" } as CliResult;
    });

    await sendMessageWithProgress({ client, kind: "antigravity", chatId, execution });

    expect(execution).toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalled();
  });

  it("slices final edit text to MAX_TELEGRAM_TEXT to prevent MESSAGE_TOO_LONG on editMessageText", async () => {
    const client = {
      sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 1, ...body } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async () => ({ ok: true })),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;
    const longText = "z".repeat(8000);

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: longText, sessionId: null }),
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.any(String) }));
  });

  it("truncates progress text to 4096 chars to stay within Telegram API limits", async () => {
    const edits: string[] = [];
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async (body: any) => { edits.push(body.text); return { ok: true }; }),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;
    const bigChunk = "x".repeat(5000);

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress(bigChunk);
        return Promise.resolve({ text: "done", sessionId: null });
      },
    });

    for (const editText of edits) {
      expect(editText.length).toBeLessThanOrEqual(4096);
    }
  });

  it("sends antigravity error text without a thinking placeholder on failure", async () => {
    const client = createMockClient();
    const chatId = 123;
    const execution = Promise.reject(new Error("CLI failed"));

    await expect(sendMessageWithProgress({ client, kind: "antigravity", chatId, execution })).resolves.toBeNull();

    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: chatId, text: "🤔 Thinking..." })
    );
    const allTexts = [
      ...(client.sendMessage as any).mock.calls.map((c: any[]) => c[0]?.text ?? ""),
      ...(client.editMessageText as any).mock.calls.map((c: any[]) => c[0]?.text ?? ""),
    ];
    expect(allTexts.some((t: string) => t.includes("❌") && t.includes("CLI failed"))).toBe(true);
  });

  it("does not send duplicate message when final edit returns 'message is not modified'", async () => {
    const client = {
      sendMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async () => {
        throw new Error("Bad Request: message is not modified: specified new message content and reply markup are identical");
      }),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: "Hello", sessionId: null }),
    });

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("calls sendMessageDraft for non-DM chats instead of editMessageText during streaming", async () => {
    const client = createMockClient();
    const chatId = 123;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress("streaming chunk");
        return Promise.resolve({ text: "done", sessionId: null });
      },
    });

    expect(client.sendMessageDraft).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chat_id: chatId, text: "done" }));
  });

  it("filters Codex JSON progress events out of streamed previews", async () => {
    const client = createMockClient();
    const chatId = 123;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId,
      execution: (onProgress: (chunk: string) => void) => {
        onProgress('{"type":"thread.started","thread_id":"019e2159-b93a-7572-9067-c78a08615db7"}\n');
        onProgress('{"type":"response.output_text.delta","delta":"Hello there"}\n');
        return Promise.resolve({ text: "Hello there", sessionId: null });
      },
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello there" }));
    expect(client.editMessageText).not.toHaveBeenCalled();
  });

  it("debounces editMessageText for DM chats — only fires immediately when >= 1500ms elapsed", async () => {
    const client = {
      sendMessage: vi.fn(async (body: any) => ({ ok: true, result: { message_id: 1, ...body } })),
      sendChatAction: vi.fn(async () => ({ ok: true })),
      editMessageText: vi.fn(async () => ({ ok: true })),
      sendMessageDraft: vi.fn(async () => ({ ok: true })),
    } as any as TelegramClient;

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: (onProgress: (chunk: string) => void) => {
        // Three rapid chunks — only the first should fire immediately (lastSendTime=0)
        onProgress("a");
        onProgress("b");
        onProgress("c");
        return Promise.resolve({ text: "final", sessionId: null });
      },
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "final" }));
  });
});

describe("sendTelegramMessage rendering", () => {
  it("renders markdown markers inside Telegram bullet lists", async () => {
    const client = createMockClient();

    await sendTelegramMessage({
      client,
      kind: "codex",
      chatId: 123,
      body: { text: "- **Codex:** run `npm test`\n- **Agy:** restarted" },
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      parse_mode: "HTML",
      text: "• <b>Codex:</b> run <code>npm test</code>\n• <b>Agy:</b> restarted",
    }));
  });

  it("renders Codex fenced code blocks with HTML pre tags instead of visible backticks", async () => {
    const client = createMockClient();

    await sendTelegramMessage({
      client,
      kind: "codex",
      chatId: 123,
      body: { text: "```text\nhello\n```" },
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      parse_mode: "HTML",
      text: '<pre language="text">hello</pre>',
    }));
    expect(client.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ parse_mode: "MarkdownV2" }));
  });

  it("renders tables as card-style HTML (not <table> tags, which Telegram rejects)", async () => {
    await withEnv({ TELEGRAM_RICH_MESSAGES_ENABLED: "true" }, async () => {
      const client = createMockClient();

      await sendTelegramMessage({
        client,
        kind: "codex",
        chatId: 123,
        body: { text: "| Service | Status |\n|---|---|\n| web-api | healthy |" },
      });

      expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: 123,
        parse_mode: "HTML",
        text: expect.stringContaining("<b>Service</b>"),
      }));
      // Must NOT contain <table> — Telegram HTML parse_mode rejects it with HTTP 400
      expect(client.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("<table"),
      }));
    });
  });

  it("keeps oversized Telegram responses as chat messages by default", async () => {
    await withEnv({
      TELEGRAM_DOCUMENT_FALLBACK_ENABLED: undefined,
      TELEGRAM_LAYOUT_DOCUMENT_THRESHOLD: "3500",
    }, async () => {
      const client = {
        ...createMockClient(),
        sendDocumentBuffer: vi.fn(async () => ({ ok: true, result: { message_id: 778 } })),
      } as any as TelegramClient;

      await sendTelegramMessage({
        client,
        kind: "codex",
        chatId: 123,
        body: { text: "x".repeat(3_501), message_thread_id: 99 },
      });

      expect(client.sendDocumentBuffer).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalled();
    });
  });

  it("uses in-memory document fallback only when explicitly enabled", async () => {
    await withEnv({
      TELEGRAM_DOCUMENT_FALLBACK_ENABLED: "true",
      TELEGRAM_LAYOUT_DOCUMENT_THRESHOLD: "3500",
    }, async () => {
      const client = {
        ...createMockClient(),
        sendDocumentBuffer: vi.fn(async () => ({ ok: true, result: { message_id: 778 } })),
      } as any as TelegramClient;

      await sendTelegramMessage({
        client,
        kind: "codex",
        chatId: 123,
        body: { text: "x".repeat(3_501), message_thread_id: 99 },
      });

      expect(client.sendDocumentBuffer).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: 123,
        message_thread_id: 99,
        filename: "response.md",
        mime_type: "text/markdown",
        caption: expect.stringContaining("Full response attached"),
      }));
      expect(client.sendMessage).not.toHaveBeenCalled();
    });
  });
});

describe("dead code removed from messageDelivery.ts", () => {
  it("unused local helpers and stale stream state are not present", () => {
    const src = readFileSync("src/messageDelivery.ts", "utf-8");
    expect(src).not.toContain("usePlaceholder");
    expect(src).not.toContain("StreamingUpdater");
    expect(src).not.toContain("activeStreams");
    expect(src).not.toContain("extractCodexProgressText");
  });
});

describe("isAborted suppression", () => {
  it("suppresses final sendTelegramMessage when isAborted() returns true", async () => {
    const client = createMockClient();
    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: "partial", sessionId: null }),
      isAborted: () => true,
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe("typingInterval cleanup on isAborted early return", () => {
  it("does not refresh typing after the abort predicate flips while execution is pending", async () => {
    vi.useFakeTimers();
    try {
      const client = createMockClient();
      let abort = false;
      let finish!: (value: CliResult) => void;
      const execution = new Promise<CliResult>((resolve) => { finish = resolve; });
      const pending = sendMessageWithProgress({ client, kind: "codex", chatId: 123, execution, isAborted: () => abort });
      await vi.advanceTimersByTimeAsync(0);
      abort = true;
      const callsBeforeRefresh = (client.sendChatAction as any).mock.calls.length;

      await vi.advanceTimersByTimeAsync(5_000);
      expect((client.sendChatAction as any).mock.calls.length).toBe(callsBeforeRefresh);

      finish({ text: "cancelled", sessionId: null });
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears typingInterval when isAborted() returns true, preventing further sendChatAction calls", async () => {
    vi.useFakeTimers();
    try {
      const client = createMockClient();

      await sendMessageWithProgress({
        client,
        kind: "codex",
        chatId: 123,
        execution: Promise.resolve({ text: "partial", sessionId: null }),
        isAborted: () => true,
      });

      // Capture the call count right after abort — only the initial sendTyping() fires
      const callsAfterAbort = (client.sendChatAction as any).mock.calls.length;

      // Advance past the 4500ms typing interval — a leaked interval would fire here
      await vi.advanceTimersByTimeAsync(5000);

      // If the interval was cleared, no new sendChatAction calls should appear
      expect((client.sendChatAction as any).mock.calls.length).toBe(callsAfterAbort);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendTelegramMessage table rendering", () => {
  const tableMarkdown = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";

  it("renders tables as card-style HTML lines, not <table> tags", async () => {
    const client = createMockClient();
    await sendTelegramMessage({ client, kind: "claude", chatId: 1, body: { text: tableMarkdown } });
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parse_mode: "HTML",
        // First column rendered as bold label, remaining as bullet lines
        text: expect.stringContaining("<b>Name</b> Alice"),
      }),
    );
    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("<table") }),
    );
  });

  it("card rendering applies regardless of TELEGRAM_RICH_MESSAGES_ENABLED", async () => {
    await withEnv({ TELEGRAM_RICH_MESSAGES_ENABLED: "true" }, async () => {
      const client = createMockClient();
      await sendTelegramMessage({ client, kind: "claude", chatId: 1, body: { text: tableMarkdown } });
      expect(client.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          parse_mode: "HTML",
          text: expect.stringContaining("<b>Name</b>"),
        }),
      );
      expect(client.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("<table") }),
      );
    });
  });

  it("falls back to card-style when sendRichMessage rejects with HTTP 400", async () => {
    const richError = Object.assign(new Error("Telegram HTTP 400: Bad Request"), { status: 400 });
    const client = {
      ...createMockClient(),
      sendRichMessage: vi.fn(async () => { throw richError; }),
    } as any;

    await sendTelegramMessage({ client, kind: "claude", chatId: 1, body: { text: tableMarkdown } });

    expect(client.sendRichMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parse_mode: "HTML",
        text: expect.stringContaining("<b>Name</b> Alice"),
      }),
    );
    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("<table") }),
    );
  });

  it("uses sendRichMessage with <table> HTML when it succeeds", async () => {
    const client = {
      ...createMockClient(),
      sendRichMessage: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
    } as any;

    await sendTelegramMessage({ client, kind: "claude", chatId: 1, body: { text: tableMarkdown } });

    expect(client.sendRichMessage).toHaveBeenCalledOnce();
    expect(client.sendRichMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        rich_message: expect.objectContaining({ html: expect.stringContaining("<table") }),
      }),
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe("sendMessageWithProgress Option 1 validation", () => {
  it("logs a warning when the legacy output and the event adapter output do not match", async () => {
    const client = createMockClient();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapterSpy = vi.spyOn(telegramAdapter, "runViewToTelegramText").mockReturnValue("mismatch text");

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: "Final answer", sessionId: null }),
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[validation] Output mismatch")
    );

    warnSpy.mockRestore();
    adapterSpy.mockRestore();
  });

  it("does not log a mismatch warning for nested markdown bold and inline code", async () => {
    const client = createMockClient();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendMessageWithProgress({
      client,
      kind: "codex",
      chatId: 123,
      execution: Promise.resolve({ text: "- **`agent-bridge-antigravity.service`**: Active", sessionId: null }),
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("typing indicator throttling", () => {
  it("keeps sendChatAction bounded when antigravity emits many rapid progress chunks", async () => {
    const client = createMockClient();
    const chatId = 321;
    const execution = async (onProgress: (t: string) => void) => {
      for (let i = 0; i < 50; i += 1) onProgress(`chunk-${i}\n`);
      return { text: "Final answer", sessionId: null } as CliResult;
    };

    await sendMessageWithProgress({ client, kind: "antigravity", chatId, execution });

    // One initial typing action plus at most interval-driven refreshes —
    // never one call per stdout chunk.
    expect((client.sendChatAction as any).mock.calls.length).toBeLessThanOrEqual(3);
  });
});
