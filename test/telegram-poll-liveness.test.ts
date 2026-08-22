import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram.js";

describe("TelegramClient poll liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("terminates the process if getUpdates remains pending beyond its request deadline plus grace", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    const fakeFetch = ((_url: string, _options: any) => new Promise(() => {})) as any;
    const client = new TelegramClient("token", fakeFetch, 45_000);

    void client.getUpdates({ timeout: 30 });

    await vi.advanceTimersByTimeAsync(74_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("cancels the liveness watchdog when getUpdates settles normally", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: [] }),
    })) as any;
    const client = new TelegramClient("token", fakeFetch, 45_000);

    await expect(client.getUpdates({ timeout: 30 })).resolves.toMatchObject({ ok: true, result: [] });
    await vi.advanceTimersByTimeAsync(75_000);

    expect(exit).not.toHaveBeenCalled();
  });

  it("cancels the liveness watchdog when getUpdates rejects", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, description: "server error" }),
    })) as any;
    const client = new TelegramClient("token", fakeFetch, 45_000);

    await expect(client.getUpdates({ timeout: 30 })).rejects.toThrow(/500/);
    await vi.advanceTimersByTimeAsync(75_000);

    expect(exit).not.toHaveBeenCalled();
  });
});
