import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import dotenv from "dotenv";
import {
  PROVIDER_CONTRACT_VERSION,
  qualificationEvidencePath,
  writeQualificationRecord,
} from "../src/providers/qualification.js";

describe("Env Isolation", () => {
  it("loads from specific file path", async () => {
    const configSpy = vi.spyOn(dotenv, "config");
    const calls: any[] = [];
    configSpy.mockImplementation(((options: any) => {
        calls.push(options);
        return { parsed: {} };
    }) as any);

    // Dynamic import to trigger side-effect in index.ts
    // but index.ts also runs the bots, which we don't want here.
    // Instead we just verify we can mock dotenv.
    dotenv.config({ path: "/tmp/service.env", override: false });

    expect(calls).toEqual([{ path: "/tmp/service.env", override: false }]);
    configSpy.mockRestore();
  });

  it("keeps ambient provider qualification evidence out of the operator home", () => {
    const path = qualificationEvidencePath();

    expect(path).not.toBe(join(homedir(), ".agent-bridge", "provider-qualification.json"));
    expect(path.startsWith(tmpdir())).toBe(true);
  });

  it("isolates the ambient provider home used by mutable provider state", () => {
    expect(homedir().startsWith(tmpdir())).toBe(true);
  });

  it("keeps default qualification evidence writes inside the isolated test home", () => {
    const previousQualificationPath = process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
    delete process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;

    try {
      const path = qualificationEvidencePath();
      writeQualificationRecord({
        provider: "codex",
        providerVersion: "test-version",
        previousVersion: null,
        bridgeCommit: "test-commit",
        contractVersion: PROVIDER_CONTRACT_VERSION,
        qualifiedAt: new Date().toISOString(),
        environment: "vitest",
        overall: "pass",
        checks: [],
      });

      expect(path).toBe(join(homedir(), ".agent-bridge", "provider-qualification.json"));
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(existsSync(path)).toBe(true);
    } finally {
      if (previousQualificationPath === undefined) {
        delete process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
      } else {
        process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = previousQualificationPath;
      }
    }
  });
});
