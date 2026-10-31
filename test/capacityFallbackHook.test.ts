/**
 * Tests for the shared onProviderFallbackRequested hook factory (#1114
 * Phase 2/3): Telegram and Discord duplicated this capacity-evidence
 * accumulation logic verbatim; Slack had none of it. This is the single
 * extracted, testable implementation all three interactive surfaces use.
 */
import { describe, it, expect, vi } from "vitest";
import { createCapacityFallbackRequestedHook } from "../src/providers/capacityFallbackHook.js";

describe("createCapacityFallbackRequestedHook", () => {
  it("records a non-capacity fallback reason without touching capacity evidence", async () => {
    const fallbackRequests = new Map<string, string>();
    const capacityFallbackAttempts = new Map<string, any>();
    const hook = createCapacityFallbackRequestedHook("codex", { fallbackRequests, capacityFallbackAttempts });

    await hook("chat:1", "auth_required" as any);

    expect(fallbackRequests.get("chat:1")).toBe("auth_required");
    expect(capacityFallbackAttempts.has("chat:1")).toBe(false);
  });

  it("records capacity evidence with the given provider and retryAfterSeconds", async () => {
    const fallbackRequests = new Map<string, string>();
    const capacityFallbackAttempts = new Map<string, any>();
    const hook = createCapacityFallbackRequestedHook("claude", { fallbackRequests, capacityFallbackAttempts });

    await hook("chat:1", "capacity" as any, {
      runId: "run-1",
      chatId: "chat:1",
      chatType: "channel",
      retryAfterSeconds: 120,
    });

    expect(fallbackRequests.get("chat:1")).toBe("capacity");
    expect(capacityFallbackAttempts.get("chat:1")).toMatchObject({
      runId: "run-1",
      provider: "claude",
      retryAfterSeconds: 120,
    });
  });

  it("combines retry evidence across repeated capacity attempts for the same chat", async () => {
    const fallbackRequests = new Map<string, string>();
    const capacityFallbackAttempts = new Map<string, any>();
    const hook = createCapacityFallbackRequestedHook("claude", { fallbackRequests, capacityFallbackAttempts });

    await hook("chat:1", "capacity" as any, { runId: "run-1", chatId: "chat:1", chatType: "channel", retryAfterSeconds: 300 });
    await hook("chat:1", "capacity" as any, { runId: "run-1", chatId: "chat:1", chatType: "channel", retryAfterSeconds: 60 });

    expect(capacityFallbackAttempts.get("chat:1")).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("marks unknown timing when neither the context nor a codex reset probe has a retry time", async () => {
    const fallbackRequests = new Map<string, string>();
    const capacityFallbackAttempts = new Map<string, any>();
    const fetchCodexCapacityResetAt = vi.fn(async () => null);
    const hook = createCapacityFallbackRequestedHook("codex", { fallbackRequests, capacityFallbackAttempts, fetchCodexCapacityResetAt });

    await hook("chat:1", "capacity" as any, { runId: "run-1", chatId: "chat:1", chatType: "channel" });

    expect(fetchCodexCapacityResetAt).toHaveBeenCalledOnce();
    expect(capacityFallbackAttempts.get("chat:1")).toMatchObject({ hasUnknownCapacityTiming: true });
  });

  it("only probes the codex reset endpoint for the codex provider", async () => {
    const fallbackRequests = new Map<string, string>();
    const capacityFallbackAttempts = new Map<string, any>();
    const fetchCodexCapacityResetAt = vi.fn(async () => null);
    const hook = createCapacityFallbackRequestedHook("claude", { fallbackRequests, capacityFallbackAttempts, fetchCodexCapacityResetAt });

    await hook("chat:1", "capacity" as any, { runId: "run-1", chatId: "chat:1", chatType: "channel" });

    expect(fetchCodexCapacityResetAt).not.toHaveBeenCalled();
  });

  it("does nothing on a capacity reason with no context", async () => {
    const fallbackRequests = new Map<string, string>();
    const capacityFallbackAttempts = new Map<string, any>();
    const hook = createCapacityFallbackRequestedHook("codex", { fallbackRequests, capacityFallbackAttempts });

    await hook("chat:1", "capacity" as any);

    expect(fallbackRequests.get("chat:1")).toBe("capacity");
    expect(capacityFallbackAttempts.has("chat:1")).toBe(false);
  });
});
