import { describe, expect, it } from "vitest";
import { prependProviderFallbackContinuation, wrapPromptContext } from "../src/promptWrapping.js";

describe("inspection-first recovery instruction", () => {
  it("applies to ordinary tool-enabled Runs without needing provider error categories", () => {
    const prompt = wrapPromptContext("Finish the implementation", null, false, true);
    expect(prompt).toContain("After a failed or interrupted Run or provider handoff");
    expect(prompt).toContain("inspect prior durable evidence");
    expect(prompt).toContain("without repeating unverified side effects");
  });

  it("recovers the existing objective rather than replaying a failed provider's work", () => {
    const prompt = prependProviderFallbackContinuation("Finish the implementation");
    expect(prompt).toContain("inspect durable conversation/Run evidence");
    expect(prompt).toContain("Identify what is complete, still required, or uncertain");
    expect(prompt).toContain("never blindly repeat side effects");
    expect(prompt).toContain("report that blocker instead of attempting to route around it");
    expect(prompt.endsWith("Finish the implementation")).toBe(true);
  });

  it("does not add an execution contract to tool-free side questions", () => {
    const prompt = wrapPromptContext("Explain this result", null, false, false);
    expect(prompt).not.toContain("After a failed or interrupted Run");
  });
});
