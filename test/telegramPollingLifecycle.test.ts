import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramClient, isTelegramUnauthorizedError } from "../src/telegram.js";

describe("Telegram polling lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies HTTP 401 as a permanent Telegram authentication failure", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    })) as typeof fetch;
    const client = new TelegramClient("bad-token", fakeFetch);

    let caught: unknown;
    try {
      await client.call("getMe");
    } catch (error) {
      caught = error;
    }
    expect(isTelegramUnauthorizedError(caught)).toBe(true);
  });

  it("fails closed instead of retrying getUpdates after HTTP 401", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    })) as typeof fetch;
    const client = new TelegramClient("bad-token", fakeFetch);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await expect(client.getUpdates({ timeout: 30 })).rejects.toThrow("process.exit:1");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("cancels an in-flight long poll and exits promptly on SIGINT", async () => {
    let fetchStarted = false;
    const fakeFetch = (async (_url: string, options: RequestInit) => {
      fetchStarted = true;
      const signal = options.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      });
    }) as typeof fetch;
    const client = new TelegramClient("token", fakeFetch);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const polling = client.getUpdates({ timeout: 30 });
    await vi.waitFor(() => expect(fetchStarted).toBe(true));
    (process as NodeJS.EventEmitter).emit("SIGINT");

    await expect(polling).rejects.toThrow("process.exit:0");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
