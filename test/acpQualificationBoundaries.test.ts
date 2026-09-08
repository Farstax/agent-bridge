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
import { qualifyProvider } from "../src/providers/qualification.js";

const savedRuntime = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
const savedCommand = process.env.CODEX_ACP_COMMAND;
const savedArgs = process.env.CODEX_ACP_ARGS;
const savedApiKey = process.env.CODEX_API_KEY;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("AGENT_BRIDGE_CODEX_RUNTIME", savedRuntime);
  restore("CODEX_ACP_COMMAND", savedCommand);
  restore("CODEX_ACP_ARGS", savedArgs);
  restore("CODEX_API_KEY", savedApiKey);
  clearProviderApiKeyVerificationCache();
});

describe("Codex ACP auth boundary", () => {
  it("lets the selected ACP adapter validate CODEX_API_KEY without invoking legacy codex exec", async () => {
    const probe = vi.fn(async () => undefined);
    const env = {
      ...process.env,
      AGENT_BRIDGE_CODEX_RUNTIME: "acp",
      CODEX_API_KEY: "test-acp-key",
    };

    await expect(verifyProviderApiKey("codex", { env, execFile: probe })).resolves.toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(isProviderApiKeyVerified("codex", env)).toBe(true);
    expect(filterProviderCredentialEnv("codex", env).CODEX_API_KEY).toBe("test-acp-key");
  });

  it("does not reuse ACP credential allowance as legacy Codex verification", async () => {
    const probe = vi.fn(async () => undefined);
    const acpEnv = {
      ...process.env,
      AGENT_BRIDGE_CODEX_RUNTIME: "acp",
      CODEX_API_KEY: "same-key",
    };
    await verifyProviderApiKey("codex", { env: acpEnv, execFile: probe });
    expect(probe).not.toHaveBeenCalled();

    const legacyEnv = { ...acpEnv, AGENT_BRIDGE_CODEX_RUNTIME: "legacy" };
    expect(isProviderApiKeyVerified("codex", legacyEnv)).toBe(false);
    await verifyProviderApiKey("codex", { env: legacyEnv, execFile: probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(isProviderApiKeyVerified("codex", legacyEnv)).toBe(true);
  });
});

describe("Codex ACP qualification boundary", () => {
  it("fails closed when the supplied qualification runtime differs from the active process runtime", async () => {
    process.env.AGENT_BRIDGE_CODEX_RUNTIME = "legacy";
    const env = { ...process.env, AGENT_BRIDGE_CODEX_RUNTIME: "acp" };

    await expect(qualifyProvider({
      providerId: "codex",
      env,
      timeoutMs: 1_000,
    })).rejects.toThrow(/qualification runtime environment mismatch/i);
  });

  it("preserves structured ACP provider classification while redacting diagnostic secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-acp-qualification-error-"));
    const failingAgent = fileURLToPath(new URL("./support/failingAcpQualificationAgent.ts", import.meta.url));
    const secret = "qualification-secret-value";
    process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
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
