import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  classifyAnyProviderError,
  classifyProviderError,
  isFallbackEligibleProviderError,
} from "../src/providers/errorClassification.js";
import { isProviderFallbackEligibleError } from "../src/providers/fallbackEligibility.js";
import { getNextFallbackModel, isCapacityExhaustedError } from "../src/cli.js";

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

  describe("ACP Codex structured error.data", () => {
    it("classifies a usageLimitExceeded RequestError as capacity_exhausted", () => {
      const error = RequestError.internalError({
        message: "Internal error",
        codexErrorInfo: "usageLimitExceeded",
      });
      expect(classifyProviderError("codex", error)).toMatchObject({ kind: "capacity_exhausted" });
      expect(isCapacityExhaustedError(error)).toBe(true);
    });

    it("classifies a rateLimitExceeded RequestError as capacity_exhausted", () => {
      const error = RequestError.internalError({
        message: "Internal error",
        codexErrorInfo: "rateLimitExceeded",
      });
      expect(classifyProviderError("codex", error)).toMatchObject({ kind: "capacity_exhausted" });
    });

    it("classifies a serverOverloaded RequestError as capacity_exhausted", () => {
      const error = RequestError.internalError({
        message: "Internal error",
        codexErrorInfo: "serverOverloaded",
      });
      expect(classifyProviderError("codex", error)).toMatchObject({ kind: "capacity_exhausted" });
    });

    it("classifies a transport_lost structured codexErrorInfo object as transient", () => {
      const error = RequestError.internalError({
        message: "Internal error",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      });
      expect(classifyProviderError("codex", error)).toMatchObject({ kind: "transient" });
    });

    it("classifies model-unavailable text carried only in nested error.data.message", () => {
      const error = RequestError.internalError({
        message: 'Error: Model "glm-5.2-fp8" not found.',
      });
      expect(classifyProviderError("codex", error)).toMatchObject({ kind: "model_unavailable" });
    });

    it("classifies an unauthorized RequestError as auth_required", () => {
      const error = RequestError.authRequired({
        message: "Authentication required",
        codexErrorInfo: "unauthorized",
      });
      expect(classifyProviderError("codex", error)).toMatchObject({ kind: "auth_required" });
    });

    it("keeps unmapped/unrecognized ACP structured error categories unknown, not capacity", () => {
      const error = RequestError.internalError({
        message: "usage limit and quota exceeded mentioned incidentally",
        codexErrorInfo: "sandboxError",
      });
      expect(classifyProviderError("codex", error)).toMatchObject({ kind: "unknown" });
      expect(isCapacityExhaustedError(error)).toBe(false);
    });

    it("drives the actual Bridge fallback path to the next configured model", () => {
      const error = RequestError.internalError({
        message: "Internal error",
        codexErrorInfo: "usageLimitExceeded",
      });
      expect(isCapacityExhaustedError(error)).toBe(true);
      const prefs = ["gpt-5.1-codex", "gpt-5.1-codex-mini"];
      expect(getNextFallbackModel("gpt-5.1-codex", prefs)).toBe("gpt-5.1-codex-mini");
    });
  });
});
