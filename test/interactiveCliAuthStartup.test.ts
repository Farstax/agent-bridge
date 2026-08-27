import { afterEach, describe, expect, it } from "vitest";
import { getAvailableCliKinds, prepareInteractiveCliAuth } from "../src/interactiveCliAuth.js";
import { clearProviderApiKeyVerificationCache, type ProviderApiKeyProbeExecutor } from "../src/providers/apiKeyAuth.js";

afterEach(() => {
  clearProviderApiKeyVerificationCache();
});

describe("interactive API-key startup", () => {
  it("completes configured-key verification before the first availability snapshot", async () => {
    const env = {
      CODEX_API_KEY: "codex-startup-key",
      CODEX_COMMAND: "fake-codex",
    };
    let calls = 0;
    const execFile: ProviderApiKeyProbeExecutor = async () => {
      calls += 1;
    };

    await prepareInteractiveCliAuth(env, execFile);
    const available = getAvailableCliKinds({
      homeDir: "/home/tester",
      env,
      exists: () => false,
      commandExists: () => true,
      readCursorStatus: () => ({ isAuthenticated: false }),
      failedProviders: new Set(),
    });

    expect(calls).toBe(1);
    expect(available).toEqual(new Set(["codex"]));
  });
});
