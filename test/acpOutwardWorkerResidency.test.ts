import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("outward capacity service residency (#1144)", () => {
  it("retains its periodic drain as an active event-loop handle until shutdown", () => {
    const source = readFileSync(new URL("../src/acpServer/continuationWorker.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const drainTimer = setInterval\(/);
    expect(source).not.toMatch(/drainTimer\.unref\(\)/);
    expect(source).toContain("clearInterval(drainTimer)");
    expect(source).toContain('process.once("SIGTERM"');
    expect(source).toContain('process.once("SIGINT"');
  });
});
