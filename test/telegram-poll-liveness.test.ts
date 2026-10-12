import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram.js";

describe("TelegramClient poll liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("terminates the process if getUpdates remains pending beyond its request deadline plus grace", async () => {
    vi.useFakeTimers();
    // Inject the exit and signal source instead of spying on the process, so no
    // other test can observe or interfere with the watchdog.
    const exit = vi.fn();
    const signals = new EventEmitter();

    // A wedged fetch ignores the client's own request timeout, which is the case
    // the watchdog exists for. The test settles it explicitly at the end so no
    // pending promise is left for async leak detection to report.
    let releaseFetch: (error: Error) => void = () => undefined;
    const fakeFetch = ((_url: string, _options: unknown) => new Promise((_resolve, reject) => {
      releaseFetch = reject;
    })) as any;
    const client = new TelegramClient("token", fakeFetch, 45_000);

    const pending = client.getUpdates({ timeout: 30 }, { signalSource: signals as never, exit: exit as never })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(74_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    releaseFetch(new Error("test released the wedged request"));
    await expect(pending).resolves.toBeInstanceOf(Error);
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
