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

  it("recovers continuations and durable receipts before generic orphan reconciliation", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source.indexOf("await engine.recoverContinuations();")).toBeGreaterThan(-1);
    expect(source.indexOf("await resumeDurablePendingHealthEvents")).toBeGreaterThan(source.indexOf("await engine.recoverContinuations();"));
    expect(source.indexOf("await bridgeDb.reconcileOrphanedRuns")).toBeGreaterThan(source.indexOf("await resumeDurablePendingHealthEvents"));
    expect(source).not.toContain("lastReportStatus");
  });

  it("detaches event execution from the scheduler report callback", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source).toContain("void executeAcceptedHealthEvent(accepted.receiptId)");
  });
});
