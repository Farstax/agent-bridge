import { describe, expect, it } from "vitest";
import {
  classifyAnyProviderError,
  classifyProviderError,
  isFallbackEligibleProviderError,
} from "../src/providers/errorClassification.js";
import { isProviderFallbackEligibleError } from "../src/providers/fallbackEligibility.js";

describe("provider error classification", () => {
  it("classifies Codex capacity and model-unavailable messages", () => {
    expect(classifyProviderError("codex", new Error("MODEL_CAPACITY_EXHAUSTED"))).toMatchObject({
      kind: "capacity_exhausted",
    });
    expect(classifyProviderError("codex", new Error("rateLimitExceeded: please retry later"))).toMatchObject({
      kind: "capacity_exhausted",
    });
    expect(classifyProviderError("codex", new Error('Error: Model "glm-5.2-fp8" not found.'))).toMatchObject({
      kind: "model_unavailable",
    });
    // Real claude CLI json-mode 404 for an unknown/unauthorized model.
    expect(classifyProviderError("claude", new Error('CLI exited with code 1: {"type":"result","is_error":true,"api_error_status":404,"result":"There\'s an issue with the selected model (claude-smoke-nonexistent-model). It may not exist or you may not have access to it."}'))).toMatchObject({
      kind: "model_unavailable",
    });
  });

  it("classifies Agy/Antigravity usage exhaustion messages", () => {
    expect(classifyProviderError("agy", new Error("No capacity available for model gemini-2.5-flash"))).toMatchObject({
      kind: "capacity_exhausted",
    });
    expect(classifyProviderError("agy", new Error("You've hit your session limit · resets 1pm"))).toMatchObject({
      kind: "capacity_exhausted",
    });
    expect(classifyProviderError("agy", new Error("RESOURCE_EXHAUSTED: quota exceeded"))).toMatchObject({
      kind: "capacity_exhausted",
    });
  });

  it("classifies Claude auth, overloaded, and rate-limit messages", () => {
    expect(classifyProviderError("claude", new Error("overloaded_error: Overloaded"))).toMatchObject({
      kind: "capacity_exhausted",
    });
    expect(classifyProviderError("claude", new Error("api_error_status:429"))).toMatchObject({
      kind: "capacity_exhausted",
    });
    expect(classifyProviderError("claude", new Error("Authentication required: please log in"))).toMatchObject({
      kind: "auth_required",
    });
  });

  it("does not classify ordinary session, file, tool, or repository errors as fallback-eligible", () => {
    const ordinaryErrors = [
      "Session abc-123 not found.",
      "ENOENT: no such file or directory, config.json not found",
      "fatal: repository 'origin' does not exist",
      "command not found: unsupported-provider",
      "tool not found: shell",
    ];

    for (const message of ordinaryErrors) {
      expect(isFallbackEligibleProviderError(classifyAnyProviderError(new Error(message)))).toBe(false);
      expect(isProviderFallbackEligibleError(new Error(message))).toBe(false);
    }
  });

  it("marks capacity and model-unavailable errors as fallback-eligible", () => {
    expect(isFallbackEligibleProviderError(classifyAnyProviderError(new Error("MODEL_CAPACITY_EXHAUSTED")))).toBe(true);
    expect(isFallbackEligibleProviderError(classifyAnyProviderError(new Error("Error: unknown model minimax-m2.5")))).toBe(true);
    expect(isProviderFallbackEligibleError(new Error("MODEL_CAPACITY_EXHAUSTED"))).toBe(true);
  });
});
