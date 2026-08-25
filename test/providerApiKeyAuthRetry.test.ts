import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderApiKeyVerificationCache,
  isProviderApiKeyVerified,
  PROVIDER_API_KEY_NEGATIVE_CACHE_TTL_MS,
  verifyProviderApiKey,
  type ProviderApiKeyProbeExecutor,
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
      CODEX_API_KEY: "codex-retry-key",
      CODEX_COMMAND: "fake-codex",
    };
    let calls = 0;
    const execFile: ProviderApiKeyProbeExecutor = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient provider failure");
    };

    await expect(verifyProviderApiKey("codex", { env, execFile })).resolves.toBe(false);
    expect(isProviderApiKeyVerified("codex", env)).toBe(false);

    await expect(verifyProviderApiKey("codex", { env, execFile })).resolves.toBe(false);
    expect(calls).toBe(1);

    vi.advanceTimersByTime(PROVIDER_API_KEY_NEGATIVE_CACHE_TTL_MS + 1);
    await expect(verifyProviderApiKey("codex", { env, execFile })).resolves.toBe(true);
    expect(isProviderApiKeyVerified("codex", env)).toBe(true);

    await expect(verifyProviderApiKey("codex", { env, execFile })).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});
