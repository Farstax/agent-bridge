import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const engineSource = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = engineSource.indexOf(startMarker);
  const end = engineSource.indexOf(endMarker, start + startMarker.length);
  expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing ${endMarker}`).toBeGreaterThan(start);
  return engineSource.slice(start, end);
}

describe("BridgeEngine provider-attempt ownership", () => {
  it("keeps sync and async public entrypoints as thin adapters over one shared attempt pipeline", () => {
    const sharedMarker = "  private async _executeProviderAttempt(";
    const sharedStart = engineSource.indexOf(sharedMarker);
    expect(sharedStart, "shared provider-attempt owner must exist").toBeGreaterThanOrEqual(0);

    const asyncWrapper = sliceBetween("  async executePromptAsync(", "  async executePrompt(");
    const syncWrapper = engineSource.slice(
      engineSource.indexOf("  async executePrompt("),
      sharedStart,
    );

    for (const wrapper of [asyncWrapper, syncWrapper]) {
      expect(wrapper).toContain("this._executeProviderAttempt(");
      for (const duplicatedOwner of [
        "buildCliInvocation(",
        "parseCliResult(",
        "_retryAntigravityFreshSession(",
        "_runWithFallback(",
        "_handleCircuitBreaker(",
      ]) {
        expect(wrapper).not.toContain(duplicatedOwner);
      }
    }

    const sharedEnd = engineSource.indexOf("  private async _runFreshAntigravityRetry(", sharedStart);
    expect(sharedEnd).toBeGreaterThan(sharedStart);
    const sharedPipeline = engineSource.slice(sharedStart, sharedEnd);
    for (const sharedResponsibility of [
      "buildCliInvocation(",
      "parseCliResult(",
      "_retryAntigravityFreshSession(",
      "_runWithFallback(",
      "_handleCircuitBreaker(",
    ]) {
      expect(sharedPipeline).toContain(sharedResponsibility);
    }
  });
});
