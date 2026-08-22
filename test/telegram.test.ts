import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramClient } from "../src/telegram.js";

describe("TelegramClient", () => {
  it("preserves retry_after metadata on 429 errors", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 0.1 } }),
    })) as any;

    const client = new TelegramClient("token", fakeFetch);

    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toMatchObject({
      status: 429,
      retryAfter: 0.1,
    });
  });

  it("automatically retries on 429 errors if retry_after is provided", async () => {
    let callCount = 0;
    const fakeFetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 123 } }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch);
    const start = Date.now();
    const result = await client.sendMessage({ chat_id: 1, text: "hi" });
    const duration = Date.now() - start;

    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(1000);
  });

  it("keeps the Telegram description text on non-429 errors", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    })) as any;

    const client = new TelegramClient("token", fakeFetch);

    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toThrow(/chat not found/);
  });

  it("supports chat actions for typing indicators", async () => {
    const calls: any[] = [];
    const fakeFetch = (async (url: string, options: any) => {
      calls.push({ url, options: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: true }),
      };
    }) as any;

    const client = new TelegramClient("token", fakeFetch);

    await client.sendChatAction({ chat_id: 1, action: "typing" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendChatAction");
    expect(calls[0].options).toEqual({ chat_id: 1, action: "typing" });
  });


  // Step 1: download methods

  it("getFilePath calls GET /getFile?file_id and returns file_path", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { file_path: "photos/file_0.jpg" } }),
      };
    }) as any;

    const client = new TelegramClient("mytoken", fakeFetch);
    const filePath = await client.getFilePath("abc123");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://api.telegram.org/botmytoken/getFile?file_id=abc123");
    expect(filePath).toBe("photos/file_0.jpg");
  });

  it("getFilePath throws on non-2xx response", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: file not found" }),
    })) as any;

    const client = new TelegramClient("mytoken", fakeFetch);
    await expect(client.getFilePath("badid")).rejects.toThrow(/400/);
  });

  it("downloadFile fetches file bytes and writes them to destPath", async () => {
    const fileBytes = Buffer.from("PNG_BYTES_HERE");
    const fakeFetch = (async (url: string) => {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
      };
    }) as any;

    const client = new TelegramClient("mytoken", fakeFetch);
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const destPath = join(dir, "out.jpg");
    try {
      await client.downloadFile("photos/file_0.jpg", destPath);
      const written = await readFile(destPath);
      expect(written).toEqual(fileBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("downloadFile calls the correct Telegram file URL", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as any;

    const client = new TelegramClient("mytoken", fakeFetch);
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const destPath = join(dir, "out.jpg");
    try {
      await client.downloadFile("photos/file_0.jpg", destPath);
      expect(calls[0]).toBe("https://api.telegram.org/file/botmytoken/photos/file_0.jpg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("downloadFile throws on non-2xx response", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 404,
    })) as any;

    const client = new TelegramClient("mytoken", fakeFetch);
    await expect(client.downloadFile("bad/path.jpg", "/tmp/x.jpg")).rejects.toThrow(/404/);
  });

  // Step 6: sendDocument / sendPhoto

  it("sendDocument makes a multipart POST to /sendDocument", async () => {
    const calls: { url: string; body: FormData }[] = [];
    const fakeFetch = (async (url: string, opts: any) => {
      calls.push({ url, body: opts.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 99 } }),
      };
    }) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "report.pdf");
    await writeFile(filePath, "PDF content");
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await client.sendDocument(42, filePath, "Here is your report");

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/sendDocument");
      const fd = calls[0].body as FormData;
      expect(fd.get("chat_id")).toBe("42");
      expect(fd.get("caption")).toBe("Here is your report");
      expect(fd.get("document")).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendDocument includes message_thread_id when provided", async () => {
    const calls: { url: string; body: FormData }[] = [];
    const fakeFetch = (async (url: string, opts: any) => {
      calls.push({ url, body: opts.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 99 } }),
      };
    }) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "report.pdf");
    await writeFile(filePath, "PDF content");
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await client.sendDocument(42, filePath, undefined, { message_thread_id: 99 });

      expect(calls).toHaveLength(1);
      expect(calls[0].body.get("message_thread_id")).toBe("99");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendDocumentBuffer makes an in-memory multipart POST to /sendDocument", async () => {
    const calls: { url: string; body: FormData }[] = [];
    const fakeFetch = (async (url: string, opts: any) => {
      calls.push({ url, body: opts.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 101 } }),
      };
    }) as any;

    const client = new TelegramClient("mytoken", fakeFetch);
    await client.sendDocumentBuffer({
      chat_id: 42,
      message_thread_id: 99,
      bytes: Buffer.from("hello"),
      filename: "response.md",
      mime_type: "text/markdown",
      caption: "Full response attached",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendDocument");
    const fd = calls[0].body;
    expect(fd.get("chat_id")).toBe("42");
    expect(fd.get("message_thread_id")).toBe("99");
    expect(fd.get("caption")).toBe("Full response attached");
    const file = fd.get("document") as File;
    expect(file.name).toBe("response.md");
    expect(file.type).toBe("text/markdown");
    expect(await file.text()).toBe("hello");
  });

  it("sendPhoto makes a multipart POST to /sendPhoto", async () => {
    const calls: { url: string; body: FormData }[] = [];
    const fakeFetch = (async (url: string, opts: any) => {
      calls.push({ url, body: opts.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 100 } }),
      };
    }) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "chart.png");
    await writeFile(filePath, Buffer.from([137, 80, 78, 71])); // PNG magic bytes
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await client.sendPhoto(42, filePath);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/sendPhoto");
      const fd = calls[0].body as FormData;
      expect(fd.get("chat_id")).toBe("42");
      expect(fd.get("photo")).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendPhoto includes message_thread_id when provided", async () => {
    const calls: { url: string; body: FormData }[] = [];
    const fakeFetch = (async (url: string, opts: any) => {
      calls.push({ url, body: opts.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 100 } }),
      };
    }) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "chart.png");
    await writeFile(filePath, Buffer.from([137, 80, 78, 71]));
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await client.sendPhoto(42, filePath, undefined, { message_thread_id: 99 });

      expect(calls).toHaveLength(1);
      expect(calls[0].body.get("message_thread_id")).toBe("99");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendDocument throws on non-2xx response", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request" }),
    })) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "x.pdf");
    await writeFile(filePath, "data");
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await expect(client.sendDocument(1, filePath)).rejects.toThrow(/400/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendPhoto throws when Telegram returns HTTP 200 but ok:false", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }),
    })) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "bad.jpg");
    await writeFile(filePath, Buffer.from([255, 216, 255]));
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await expect(client.sendPhoto(1, filePath)).rejects.toThrow(/PHOTO_INVALID_DIMENSIONS/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendDocument throws when Telegram returns HTTP 200 but ok:false", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: "Bad Request: file too large" }),
    })) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "big.pdf");
    await writeFile(filePath, "data");
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await expect(client.sendDocument(1, filePath)).rejects.toThrow(/file too large/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendPhoto sets correct MIME type on the Blob for .jpg files", async () => {
    let capturedBlob: Blob | null = null;
    const fakeFetch = (async (_url: string, opts: any) => {
      capturedBlob = (opts.body as FormData).get("photo") as Blob;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    }) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "photo.jpg");
    await writeFile(filePath, Buffer.from([255, 216, 255]));
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await client.sendPhoto(1, filePath);
      expect(capturedBlob?.type).toBe("image/jpeg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sendPhoto sets correct MIME type on the Blob for .png files", async () => {
    let capturedBlob: Blob | null = null;
    const fakeFetch = (async (_url: string, opts: any) => {
      capturedBlob = (opts.body as FormData).get("photo") as Blob;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    }) as any;

    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const filePath = join(dir, "chart.png");
    await writeFile(filePath, Buffer.from([137, 80, 78, 71]));
    try {
      const client = new TelegramClient("mytoken", fakeFetch);
      await client.sendPhoto(1, filePath);
      expect(capturedBlob?.type).toBe("image/png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
