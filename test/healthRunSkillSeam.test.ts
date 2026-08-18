import { describe, expect, it } from "vitest";

import {
  buildHealthOpsPrompt,
  HEALTH_RUN_AUTHORITY_SCOPE,
} from "../src/health/eventIngress.js";

describe("health investigation ordinary Run seam", () => {
  it("hands a red observation to the health-troubleshooting skill without expanding authority", () => {
    const prompt = buildHealthOpsPrompt({
      pluginName: "server",
      status: "red",
      checks: [{ name: "disk-space", status: "red", message: "2% free" }],
      summary: "disk critically low",
    });

    expect(prompt).toContain("health-troubleshooting");
    expect(prompt).toContain(HEALTH_RUN_AUTHORITY_SCOPE);
  });
});
