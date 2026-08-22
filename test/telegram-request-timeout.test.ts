import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramClient } from "../src/telegram.js";

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

describe("TelegramClient request deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the request deadline active while consuming the response body", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;

    const fakeFetch = (async (_url: string, options: any) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch, 50);
    const request = client.sendMessage({ chat_id: 1, text: "hi" });
    const outcome = request.then(() => "resolved", (error) => error?.name);

    await vi.advanceTimersByTimeAsync(50);

    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe("AbortError");
  });

  it("keeps the getFile deadline active while consuming JSON", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;

    const fakeFetch = (async (_url: string, options: any) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch, 50);
    const request = client.getFilePath("file-id");
    const outcome = request.then(() => "resolved", (error) => error?.name);

    await vi.advanceTimersByTimeAsync(50);

    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe("AbortError");
  });

  it("keeps the download deadline active while consuming file bytes", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;

    const fakeFetch = (async (_url: string, options: any) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        arrayBuffer: () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch, 50);
    const request = client.downloadFile("photos/file.jpg", "/tmp/agent-bridge-timeout-never-written");
    const outcome = request.then(() => "resolved", (error) => error?.name);

    await vi.advanceTimersByTimeAsync(50);

    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe("AbortError");
  });

  it("keeps multipart upload deadlines active while consuming JSON", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;

    const fakeFetch = (async (_url: string, options: any) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
      };
    }) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-telegram-timeout-"));
    const filePath = join(dir, "report.pdf");
    await writeFile(filePath, "pdf");

    try {
      const client = new TelegramClient("token", fakeFetch, 50);
      const request = client.sendDocument(1, filePath);
      const outcome = request.then(() => "resolved", (error) => error?.name);

      await vi.advanceTimersByTimeAsync(50);

      expect(signal?.aborted).toBe(true);
      await expect(outcome).resolves.toBe("AbortError");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps buffered document upload deadlines active while consuming JSON", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;

    const fakeFetch = (async (_url: string, options: any) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch, 50);
    const request = client.sendDocumentBuffer({
      chat_id: 1,
      bytes: Buffer.from("hello"),
      filename: "response.txt",
      mime_type: "text/plain",
    });
    const outcome = request.then(() => "resolved", (error) => error?.name);

    await vi.advanceTimersByTimeAsync(50);

    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe("AbortError");
  });

  it("gives long polls 30 seconds of transport headroom", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;

    const fakeFetch = ((_url: string, options: any) => {
      signal = options.signal;
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }) as any;

    const client = new TelegramClient("token", fakeFetch, 45_000);
    const request = client.getUpdates({ timeout: 30 });
    const outcome = request.then(() => "resolved", (error) => error?.name);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe("AbortError");
  });

  it("creates a fresh request after consecutive aborts and can recover", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const initiallyAborted: boolean[] = [];
    let callCount = 0;

    const fakeFetch = ((_url: string, options: any) => {
      callCount += 1;
      signals.push(options.signal);
      initiallyAborted.push(options.signal.aborted);

      if (callCount <= 2) {
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: [{ update_id: 123 }] }),
      });
    }) as any;

    const client = new TelegramClient("token", fakeFetch, 20);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const request = client.getUpdates({});
      const outcome = request.then(() => "resolved", (error) => error?.name);
      await vi.advanceTimersByTimeAsync(20);
      await expect(outcome).resolves.toBe("AbortError");
    }

    const recovered = await client.getUpdates({});

    expect(recovered.result).toEqual([{ update_id: 123 }]);
    expect(initiallyAborted).toEqual([false, false, false]);
    expect(new Set(signals).size).toBe(3);
  });
});
