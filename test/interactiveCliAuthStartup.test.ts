import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAvailableCliKinds,
  prepareInteractiveCliAuth,
  prepareInteractiveCliAuthStartup,
} from "../src/interactiveCliAuth.js";
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

  it("loads the canonical interactive env before startup auth verification", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-interactive-auth-"));
    try {
      await writeFile(
        join(cwd, "custom.env"),
        "CODEX_API_KEY=codex-env-startup-key\nCODEX_COMMAND=fake-codex\n",
        "utf8",
      );
      const env: NodeJS.ProcessEnv = {
        BRIDGE_ENV_FILE: "  custom.env  ",
      };
      let calls = 0;
      const execFile: ProviderApiKeyProbeExecutor = async () => {
        calls += 1;
      };

      await prepareInteractiveCliAuthStartup({ env, cwd, execFile });
      const available = getAvailableCliKinds({
        homeDir: "/home/tester",
        env,
        exists: () => false,
        commandExists: () => true,
        readCursorStatus: () => ({ isAuthenticated: false }),
        failedProviders: new Set(),
      });

      expect(env.CODEX_API_KEY).toBe("codex-env-startup-key");
      expect(env.CODEX_COMMAND).toBe("fake-codex");
      expect(calls).toBe(1);
      expect(available).toEqual(new Set(["codex"]));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
