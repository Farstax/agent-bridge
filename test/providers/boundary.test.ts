import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProviderAdapters, assertProviderId } from "../../src/providers/registry.js";
import { PROVIDER_IDS } from "../../src/providers/types.js";

const SRC = join(__dirname, "..", "..", "src");

const REMOVED_WORKFLOW_MODULES = ["./workerBot.js", "./jobExecutor.js", "./workerDispatch.js", "./prMergeGate.js", "./workspace.js"];

function importsOf(file: string): string[] {
  const text = readFileSync(join(SRC, file), "utf8");
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
}

describe("product boundaries", () => {
  it("companion entries do not import worker-only modules", () => {
    for (const companionFile of ["interactiveBot.ts", "engine.ts", "index-interactive.ts"]) {
      const imports = importsOf(companionFile);
      for (const moduleName of REMOVED_WORKFLOW_MODULES) {
        expect(imports, `${companionFile} must not import ${moduleName}`).not.toContain(moduleName);
      }
    }
  });

  it("provider fallback order is deterministic and matches PROVIDER_IDS", () => {
    const order = getProviderAdapters().map((a) => a.id);
    expect(order).toEqual([...PROVIDER_IDS]);
    expect(getProviderAdapters().map((a) => a.id)).toEqual(order);
  });

  it("unknown provider ids fail clearly", () => {
    expect(() => assertProviderId("made-up-cli")).toThrow(/made-up-cli/);
  });
});
