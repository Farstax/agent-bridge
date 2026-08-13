import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("health event production wiring", () => {
  it("routes raw scheduler reports through authenticated receipt, Run execution, and reconciliation", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./health/eventIngress.js"');
    expect(source).toContain("acceptHealthOpsEvent");
    expect(source).toContain("executeHealthOpsRun");
    expect(source).toContain("reconcileEventReceiptResult");
    expect(source).toContain("onRawReport: async (report)");
  });
});
