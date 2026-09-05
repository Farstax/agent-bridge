import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  TelegramClient,
  isTelegramUnauthorizedError,
  type TelegramPollingSignalSource,
} from "../src/telegram.js";

function testLifecycle() {
  const signals = new EventEmitter() as TelegramPollingSignalSource & EventEmitter;
  const exits: number[] = [];
  const exit = (code: number): never => {
    exits.push(code);
    throw new Error(`process.exit:${code}`);
  };
  return { signals, exits, exit };
}

describe("Telegram polling lifecycle", () => {
  it("classifies HTTP 401 as a permanent Telegram authentication failure", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    })) as any;
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
    })) as any;
    const client = new TelegramClient("bad-token", fakeFetch);
    const lifecycle = testLifecycle();

    await expect(client.getUpdates({ timeout: 30 }, {
      signalSource: lifecycle.signals,
      exit: lifecycle.exit,
    })).rejects.toThrow("process.exit:1");
    expect(lifecycle.exits).toEqual([1]);
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
    }) as any;
    const client = new TelegramClient("token", fakeFetch);
    const lifecycle = testLifecycle();

    const polling = client.getUpdates({ timeout: 30 }, {
      signalSource: lifecycle.signals,
      exit: lifecycle.exit,
    });
    await vi.waitFor(() => expect(fetchStarted).toBe(true));
    lifecycle.signals.emit("SIGINT");

    await expect(polling).rejects.toThrow("process.exit:0");
    expect(lifecycle.exits).toEqual([0]);
  });
});
