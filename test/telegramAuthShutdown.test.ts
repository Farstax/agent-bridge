import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForAbortableDelay } from "../src/interactiveShutdown.js";
import { TelegramClient, TelegramHttpError, isTelegramPermanentAuthError } from "../src/telegram.js";

describe("Telegram authentication and shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([401, 403])("classifies HTTP %i as a permanent auth failure", async (status) => {
    const fakeFetch = (async () => ({
      ok: false,
      status,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    })) as any;
    const client = new TelegramClient("bad-token", fakeFetch);

    let caught: unknown;
    try {
      await client.getUpdates({ timeout: 30 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TelegramHttpError);
    expect(caught).toMatchObject({ status });
    expect(isTelegramPermanentAuthError(caught)).toBe(true);
  });

  it("does not classify transient Telegram failures as permanent auth errors", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, description: "server error" }),
    })) as any;
    const client = new TelegramClient("token", fakeFetch);

    let caught: unknown;
    try {
      await client.getUpdates({ timeout: 30 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ status: 500 });
    expect(isTelegramPermanentAuthError(caught)).toBe(false);
  });

  it("aborts an active long poll when the runtime shutdown signal fires", async () => {
    const shutdown = new AbortController();
    const fakeFetch = ((_url: string, options: any) => new Promise((_resolve, reject) => {
      const rejectAborted = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (options.signal.aborted) rejectAborted();
      else options.signal.addEventListener("abort", rejectAborted, { once: true });
    })) as any;
    const client = new TelegramClient("token", fakeFetch, 45_000, shutdown.signal);

    const pending = client.getUpdates({ timeout: 30 });
    await Promise.resolve();
    shutdown.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels the poll retry delay immediately on shutdown", async () => {
    vi.useFakeTimers();
    const shutdown = new AbortController();
    const pending = waitForAbortableDelay(5_000, shutdown.signal);

    shutdown.abort();

    await expect(pending).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
