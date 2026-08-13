import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("health event production wiring", () => {
  it("routes raw scheduler reports through authenticated receipt, Run execution, and reconciliation", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./health/eventIngress.js"');
    expect(source).toContain('from "./health/eventRecovery.js"');
    expect(source).toContain("acceptHealthOpsEvent");
    expect(source).toContain("executeHealthOpsRun");
    expect(source).toContain("reconcileEventReceiptResult");
    expect(source).toContain("onRawReport: async (report)");
  });

  it("recovers continuations before non-blocking receipt replay and generic orphan reconciliation", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    const continuations = source.indexOf("await engine.recoverContinuations();");
    const pending = source.indexOf("void resumeDurablePendingHealthEvents");
    const orphans = source.indexOf("await bridgeDb.reconcileOrphanedRuns");
    expect(continuations).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(continuations);
    expect(orphans).toBeGreaterThan(pending);
    expect(source).not.toContain("await resumeDurablePendingHealthEvents");
    expect(source).not.toContain("lastReportStatus");
  });

  it("accepts a red episode before persisting the incoming red report", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function handleHealthReportEventIngress");
    const end = source.indexOf("const scheduler = new HealthScheduler", start);
    const handler = source.slice(start, end);
    expect(handler).toContain("healthRedEpisodeIdempotencyKey");
    expect(handler.indexOf("acceptHealthOpsEvent")).toBeGreaterThan(-1);
    expect(handler.indexOf("await healthBot.handleReport(report)")).toBeGreaterThan(handler.indexOf("acceptHealthOpsEvent"));
  });

  it("detaches event execution from the scheduler report callback", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source).toContain("void executeAcceptedHealthEvent(accepted.receiptId)");
  });
});
