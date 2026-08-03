import { describe, expect, it, vi } from "vitest";

describe("integrated health command routing", () => {
  it("claims /health, acknowledges it first, and completes checks outside the poll path", async () => {
    const { handleIntegratedHealthCommand } = await import("../src/health/integrated.js");
    let resolveCheck: ((text: string) => void) | undefined;
    const runCheck = vi.fn(() => new Promise<string>((resolve) => { resolveCheck = resolve; }));
    const sendText = vi.fn(async () => {});

    await expect(handleIntegratedHealthCommand({
      rawText: "/health", chatId: 42, runCheck, getStatus: () => "unused", sendText,
    })).resolves.toBe(true);

    expect(runCheck).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith("Checking health...");
    resolveCheck!("Health report");
    await vi.waitFor(() => expect(sendText).toHaveBeenLastCalledWith("Health report"));
  });

  it("claims /health status without sending it to an interactive CLI", async () => {
    const { handleIntegratedHealthCommand } = await import("../src/health/integrated.js");
    const sendText = vi.fn(async () => {});
    const runCheck = vi.fn(async () => "unused");

    await expect(handleIntegratedHealthCommand({
      rawText: "/health status", chatId: 42, runCheck, getStatus: () => "Last health report", sendText,
    })).resolves.toBe(true);

    expect(runCheck).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("Last health report");
  });

  it("does not claim normal interactive messages or commands for another bot", async () => {
    const { handleIntegratedHealthCommand } = await import("../src/health/integrated.js");
    const args = { chatId: 42, runCheck: async () => "unused", getStatus: () => "unused", sendText: async () => {} };
    await expect(handleIntegratedHealthCommand({ ...args, rawText: "hello" })).resolves.toBe(false);
    await expect(handleIntegratedHealthCommand({ ...args, rawText: "/health@another_bot", botUsername: "interactive_bot" })).resolves.toBe(false);
  });
});
