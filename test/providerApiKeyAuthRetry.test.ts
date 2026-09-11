import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderApiKeyVerificationCache,
  isProviderApiKeyVerified,
  PROVIDER_API_KEY_NEGATIVE_CACHE_TTL_MS,
  verifyProviderApiKey,
  type AcpApiKeyProbeExecutor,
} from "../src/providers/apiKeyAuth.js";

afterEach(() => {
  clearProviderApiKeyVerificationCache();
  vi.useRealTimers();
});

describe("provider API-key verification retry", () => {
  it("throttles a transient failure, then retries and caches the later success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T10:00:00Z"));
    const env = {
      ANTHROPIC_API_KEY: "claude-retry-key",
    };
    let calls = 0;
    const claudeAcpProbe: AcpApiKeyProbeExecutor = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient provider failure");
    };

    await expect(verifyProviderApiKey("claude", { env, claudeAcpProbe })).resolves.toBe(false);
    expect(isProviderApiKeyVerified("claude", env)).toBe(false);

    await expect(verifyProviderApiKey("claude", { env, claudeAcpProbe })).resolves.toBe(false);
    expect(calls).toBe(1);

    vi.advanceTimersByTime(PROVIDER_API_KEY_NEGATIVE_CACHE_TTL_MS + 1);
    await expect(verifyProviderApiKey("claude", { env, claudeAcpProbe })).resolves.toBe(true);
    expect(isProviderApiKeyVerified("claude", env)).toBe(true);

    await expect(verifyProviderApiKey("claude", { env, claudeAcpProbe })).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});
