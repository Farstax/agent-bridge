import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("production source hygiene", () => {
  const entrypoints = [
    "src/index-interactive.ts",
    "src/index-discord-interactive.ts",
  ];

  it("entrypoints do not record conversation turns (engine._rememberTurn is the single recorder)", () => {
    for (const file of entrypoints) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} duplicates engine turn recording`).not.toContain("fallbackChain.addTurn");
    }
  });

  it("entrypoints and dispatchers do not inject context preambles (engine injects context once per execution)", () => {
    for (const file of [...entrypoints, "src/interactiveBot.ts", "src/providerFallback.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} duplicates engine context injection`).not.toContain("buildContextPreamble");
      expect(source, `${file} duplicates engine context injection`).not.toContain("contextPreambles");
    }
  });
});
