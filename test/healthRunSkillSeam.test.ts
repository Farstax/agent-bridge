import { describe, expect, it } from "vitest";

import { buildHealthOpsPrompt } from "../src/health/eventIngress.js";

describe("health investigation ordinary Run seam", () => {
  it("hands a red observation to the health-troubleshooting skill without expanding authority", () => {
    const prompt = buildHealthOpsPrompt({
      pluginName: "server",
      status: "red",
      checks: [{ name: "disk-space", status: "red", message: "2% free" }],
      summary: "disk critically low",
    });

    expect(prompt).toContain("Investigate this health observation using the `health-troubleshooting` skill.");
    expect(prompt).toContain("health:report-only");
    expect(prompt).toContain("does not grant deploy, restart, or repository-mutation authority");
  });
});
