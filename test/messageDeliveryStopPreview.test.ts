import { describe, expect, it, vi } from "vitest";
import { sendMessageWithProgress } from "../src/messageDelivery.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { CliResult } from "../src/types.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

for (const kind of ["claude", "antigravity"] as const) {
  describe(`${kind} pending answer preview cancellation`, () => {
    it("returns after fencing without waiting for the pending preview request and deletes a late preview", async () => {
      let releasePreview!: (value: any) => void;
      let previewStarted!: () => void;
      const previewStartedPromise = new Promise<void>((resolve) => { previewStarted = resolve; });
      const previewResponse = new Promise<any>((resolve) => { releasePreview = resolve; });
      const sendMessage = vi.fn(async () => {
        previewStarted();
        return previewResponse;
      });
      const deleteMessage = vi.fn(async () => ({ ok: true, result: true }));
      const client = {
        capabilities: TELEGRAM_SURFACE_CAPABILITIES,
        sendMessage,
        sendChatAction: vi.fn(async () => ({ ok: true, result: true })),
        editMessageText: vi.fn(async () => ({ ok: true, result: true })),
        deleteMessage,
      } as any;

      let aborted = false;
      const run = sendMessageWithProgress({
        client,
        kind,
        chatId: 123,
        isAborted: () => aborted,
        execution: async (_onProgress, onAnswerDelta) => {
          onAnswerDelta("preview in flight");
          await previewStartedPromise;
          aborted = true;
          return { text: "must not be delivered", sessionId: "s1" } as CliResult;
        },
      });

      const settledBeforePreview = await Promise.race([
        run.then((result) => ({ settled: true as const, result })),
        new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 100)),
      ]);
      expect(settledBeforePreview).toEqual({ settled: true, result: null });
      expect(deleteMessage).not.toHaveBeenCalled();

      releasePreview({ ok: true, result: { message_id: 456 } });
      await flushMicrotasks();
      expect(deleteMessage).toHaveBeenCalledWith({ chat_id: 123, message_id: 456 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(client.editMessageText).not.toHaveBeenCalled();
    });
  });
}
