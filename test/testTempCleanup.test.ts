import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testRoot = fileURLToPath(new URL(".", import.meta.url));

function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("test temporary fixture cleanup", () => {
  // Vitest fork workers exit without emitting process "exit", so cleanup
  // registered there never runs and every suite run leaks its fixtures.
  it("does not rely on process exit handlers to remove fixtures", () => {
    const offenders = testSources(testRoot)
      .filter((path) => !path.endsWith("testTempCleanup.test.ts"))
      .filter((path) => /process\.(on|once)\(\s*["'](exit|beforeExit)["']/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(testRoot.length));
    expect(offenders).toEqual([]);
  });
});
