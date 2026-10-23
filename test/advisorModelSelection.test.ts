import { describe, expect, it } from "vitest";
import { advisorModelClass, selectAdvisorClassModel } from "../src/advisorModelSelection.js";
import { acpSessionConfigIntents } from "../src/acp/sessionConfig.js";

const catalogue = (...values: string[]) => [{
  id: "model", category: "model", type: "select",
  options: values.map((value) => ({ value })),
}];

describe("Advisor dynamic class selection", () => {
  it("selects the highest numeric Opus version even when the catalogue is out of order", () => {
    expect(selectAdvisorClassModel(catalogue("claude-opus-5-10", "claude-opus-5-9", "claude-sonnet-6", "claude-opus-5-5"), "opus"))
      .toBe("claude-opus-5-10");
  });
  it("recognizes Sol versions only in the exact class, without inventing names", () => {
    expect(selectAdvisorClassModel(catalogue("gpt-6-sol", "gpt-6-1-sol", "gpt-7-soleil"), "sol"))
      .toBe("gpt-6-1-sol");
  });
  it("chooses provider default on no match, no model category, malformed versions or ambiguous ties", () => {
    expect(selectAdvisorClassModel(catalogue("claude-sonnet-6"), "opus")).toBeNull();
    expect(selectAdvisorClassModel([], "opus")).toBeNull();
    expect(selectAdvisorClassModel(catalogue("opus"), "opus")).toBeNull();
    expect(selectAdvisorClassModel(catalogue("claude-opus-5-5", "opus-5-5"), "opus")).toBeNull();
  });
  it("only supports explicitly agreed provider/class combinations", () => {
    expect(advisorModelClass("claude", "opus")).toBe("opus");
    expect(advisorModelClass("codex", "sol")).toBe("sol");
    expect(advisorModelClass("codex", "opus")).toBeNull();
    expect(advisorModelClass("claude", "claude-opus-5-5")).toBeNull();
  });
  it("ignores configured model preferences when provider default is explicitly requested", () => {
    expect(acpSessionConfigIntents("claude", { model: null, modelUseProviderDefault: true, effort: null }, {
      model: ["retired-model"],
    })).toMatchObject([{ category: "model", useProviderDefault: true }]);
  });
});
