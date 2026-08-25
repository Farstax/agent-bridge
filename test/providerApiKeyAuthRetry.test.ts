import { afterEach, describe, expect, it } from "vitest";
import {
  clearProviderApiKeyVerificationCache,
  isProviderApiKeyVerified,
  verifyProviderApiKey,
  type ProviderApiKeyProbeExecutor,
} from "../src/providers/apiKeyAuth.js";

afterEach(() => {
  clearProviderApiKeyVerificationCache();
});

describe("provider API-key verification retry", () => {
  it("retries a transient failure and caches the later success", async () => {
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

    await expect(verifyProviderApiKey("codex", { env, execFile })).resolves.toBe(true);
    expect(isProviderApiKeyVerified("codex", env)).toBe(true);

    await expect(verifyProviderApiKey("codex", { env, execFile })).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});
