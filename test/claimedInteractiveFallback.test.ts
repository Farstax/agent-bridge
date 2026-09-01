import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { dispatchClaimedInteractiveWithFallback } from "../src/interactiveBot.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";

describe("claimed interactive fallback", () => {
  it("does not inspect transport ingress fields before executing durable queued work", async () => {
    const db = openDb(":memory:");
    try {
      const forbidden = new Set(["laneHandle", "userId", "threadId", "chatId", "chatType"]);
      const message = new Proxy({ id: 1, prompt: "queued work" } as any, {
        get(target, property, receiver) {
          if (typeof property === "string" && forbidden.has(property)) {
            throw new Error(`claimed fallback inspected ${property}`);
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const executeClaimedMessage = vi.fn(async () => "committed" as const);
      const fallbackChain = new ProviderFallbackChain(["codex"], db, () => true);

      await expect(dispatchClaimedInteractiveWithFallback(message, "discord-channel", {
        engines: { codex: { executeClaimedMessage } },
        fallbackChain,
        exhaustedChats: new Set<string>(),
        db,
        notify: vi.fn(),
      })).resolves.toBe("committed");

      expect(executeClaimedMessage).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
