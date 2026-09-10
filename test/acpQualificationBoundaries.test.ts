import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderApiKeyVerificationCache,
  filterProviderCredentialEnv,
  isProviderApiKeyVerified,
  verifyProviderApiKey,
} from "../src/providers/apiKeyAuth.js";
import { runCodexAcpApiKeyProbe } from "../src/providers/codexAcpAuthProbe.js";
import { qualifyProvider } from "../src/providers/qualification.js";

const savedCommand = process.env.CODEX_ACP_COMMAND;
const savedArgs = process.env.CODEX_ACP_ARGS;
const savedApiKey = process.env.CODEX_API_KEY;
const savedCurrentRelease = process.env.BRIDGE_CURRENT_RELEASE_DIR;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("CODEX_ACP_COMMAND", savedCommand);
  restore("CODEX_ACP_ARGS", savedArgs);
  restore("CODEX_API_KEY", savedApiKey);
  restore("BRIDGE_CURRENT_RELEASE_DIR", savedCurrentRelease);
  clearProviderApiKeyVerificationCache();
});

describe("Codex ACP auth boundary", () => {
  it("verifies CODEX_API_KEY through ACP through the managed ACP adapter", async () => {
    const legacyProbe = vi.fn(async () => undefined);
    const acpProbe = vi.fn(async () => undefined);
    const env = {
      ...process.env,
      CODEX_API_KEY: "test-acp-key",
    };

    await expect(verifyProviderApiKey("codex", {
      env,
      execFile: legacyProbe,
      codexAcpProbe: acpProbe,
    })).resolves.toBe(true);
    expect(acpProbe).toHaveBeenCalledTimes(1);
    expect(legacyProbe).not.toHaveBeenCalled();
    expect(isProviderApiKeyVerified("codex", env)).toBe(true);
    expect(filterProviderCredentialEnv("codex", env).CODEX_API_KEY).toBe("test-acp-key");
  });

  it("keeps an invalid ACP key unverified and withheld from production children", async () => {
    const env = {
      ...process.env,
      CODEX_API_KEY: "bad-acp-key",
    };
    const acpProbe = vi.fn(async () => { throw new Error("authentication failed"); });

    await expect(verifyProviderApiKey("codex", { env, codexAcpProbe: acpProbe })).resolves.toBe(false);
    expect(isProviderApiKeyVerified("codex", env)).toBe(false);
    expect(filterProviderCredentialEnv("codex", env).CODEX_API_KEY).toBeUndefined();
  });

  it("runs the production ACP auth probe over stdio and rejects a bad key", async () => {
    const fakeAgent = fileURLToPath(new URL("./support/fakeCodexAcpAuthAgent.ts", import.meta.url));
    const baseEnv = {
      ...process.env,
      CODEX_ACP_COMMAND: process.execPath,
      CODEX_ACP_ARGS: `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`,
    };

    await expect(runCodexAcpApiKeyProbe({ ...baseEnv, CODEX_API_KEY: "valid-acp-key" })).resolves.toBeUndefined();
    await expect(runCodexAcpApiKeyProbe({ ...baseEnv, CODEX_API_KEY: "bad-acp-key" })).rejects.toThrow();
  }, 15_000);
});

describe("Codex ACP qualification boundary", () => {
  it("fails closed when qualification and runtime resolve different managed releases", async () => {
    process.env.BRIDGE_CURRENT_RELEASE_DIR = "/opt/agent-bridge/releases/runtime";

    await expect(qualifyProvider({
      providerId: "codex",
      env: {
        ...process.env,
        BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge/releases/candidate",
      },
    })).rejects.toThrow(/runtime environment mismatch for BRIDGE_CURRENT_RELEASE_DIR/i);
  });

  it("preserves structured ACP provider classification while redacting diagnostic secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-acp-qualification-error-"));
    const failingAgent = fileURLToPath(new URL("./support/failingAcpQualificationAgent.ts", import.meta.url));
    const secret = "qualification-secret-value";
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${failingAgent}`;
    process.env.CODEX_API_KEY = secret;

    try {
      const result = await qualifyProvider({
        providerId: "codex",
        evidencePath: join(root, "qualification.json"),
        bridgeCommit: "f".repeat(40),
        cwd: root,
        homeDir: root,
        timeoutMs: 5_000,
        env: { ...process.env },
      });

      expect(result.overall).toBe("degraded");
      const check = result.checks.find((candidate) => candidate.name === "fresh_prompt");
      expect(check).toMatchObject({
        status: "capacity_exhausted",
        diagnostic: expect.stringMatching(/usage limit|usageLimitExceeded/i),
      });
      expect(check?.diagnostic).not.toContain(secret);
      expect(check?.diagnostic).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
