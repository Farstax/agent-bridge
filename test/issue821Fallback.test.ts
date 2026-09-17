import { describe, expect, it } from "vitest";
import { toUserMessage } from "../src/cli.js";
import { classifyProviderError } from "../src/providers/errorClassification.js";

describe("issue #821 provider authentication failure", () => {
  const claudeOAuthExpired = new Error(
    "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
  );

  it("classifies the production Claude OAuth expiry as auth_required", () => {
    expect(classifyProviderError("claude", claudeOAuthExpired).kind).toBe("auth_required");
  });

  it("does not collapse the actionable authentication failure to Internal error", () => {
    expect(toUserMessage(claudeOAuthExpired)).toBe("Authentication required");
  });
});
