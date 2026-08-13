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

  it("reconciles abandoned health leases after generic orphan reconciliation, before final receipt correlation", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./health/eventRecovery.js"');
    expect(source).toContain("reconcileAbandonedHealthLeases");
    const genericOrphans = source.indexOf("await bridgeDb.reconcileOrphanedRuns");
    const healthLeases = source.indexOf("await reconcileAbandonedHealthLeases(bridgeDb", genericOrphans);
    const finalCorrelation = source.lastIndexOf("reconcileTerminalPendingHealthEvents(bridgeDb)");
    expect(genericOrphans).toBeGreaterThan(-1);
    expect(healthLeases).toBeGreaterThan(genericOrphans);
    expect(finalCorrelation).toBeGreaterThan(healthLeases);
  });

  it("arranges exactly one bounded setTimeout retry for an abandoned health lease whose lock hasn't yet expired, with no rescheduling inside that retry", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");
    const genericOrphans = source.indexOf("await bridgeDb.reconcileOrphanedRuns");
    const start = source.indexOf("await reconcileAbandonedHealthLeases(bridgeDb", genericOrphans);
    const end = source.indexOf("reconcileTerminalPendingHealthEvents(bridgeDb)", start);
    const block = source.slice(start, end);
    expect(block).toContain("scheduleRetry: (delayMs)");
    expect(block).toContain("setTimeout(");
    const retryCallStart = block.indexOf("reconcileAbandonedHealthLeases(bridgeDb", block.indexOf("setTimeout("));
    const retryCallEnd = block.indexOf(")\n", retryCallStart);
    expect(block.slice(retryCallStart, retryCallEnd)).not.toContain("scheduleRetry");
  });

  it("gives interrupted marked health Runs a reconciliation opportunity after live execution and startup replay release the shared lane", () => {
    const source = readFileSync(new URL("../src/index-health.ts", import.meta.url), "utf8");

    const helperStart = source.indexOf("async function reconcileInterruptedHealthRunsAfterExecution");
    const helperEnd = source.indexOf("async function executeAcceptedHealthEvent", helperStart);
    const helper = source.slice(helperStart, helperEnd);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain("await reconcileAbandonedHealthLeases(bridgeDb");
    expect(helper).toContain("reconcileTerminalPendingHealthEvents(bridgeDb)");

    const liveStart = source.indexOf("async function executeAcceptedHealthEvent");
    const liveEnd = source.indexOf("async function handleHealthReportEventIngress", liveStart);
    const liveOwner = source.slice(liveStart, liveEnd);
    expect(liveOwner).toContain("await reconcileInterruptedHealthRunsAfterExecution()");

    const replayStart = source.indexOf("void resumeDurablePendingHealthEvents");
    const replayEnd = source.indexOf("await bridgeDb.reconcileOrphanedRuns", replayStart);
    const replayOwner = source.slice(replayStart, replayEnd);
    expect(replayOwner).toContain(".then(() => reconcileInterruptedHealthRunsAfterExecution())");
  });
});
