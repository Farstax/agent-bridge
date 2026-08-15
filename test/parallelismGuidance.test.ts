import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const requirementsToAcceptance = readFileSync(
  new URL("../skills/requirements-to-acceptance/SKILL.md", import.meta.url),
  "utf8",
);

describe("dependency-aware native parallelism guidance", () => {
  it("keeps the dependency test in the canonical decomposition owner, not duplicated in AGENTS.md", () => {
    expect(requirementsToAcceptance).toContain("what exact output from the earlier step the later step consumes");
    expect(agents).not.toContain("what exact output from the earlier step the later step consumes");
  });

  it("scopes provider-native fan-out and deterministic reduction to the Core Architecture Principle", () => {
    expect(agents).toContain("Provider-native fan-out (subagents, teams, parallel tool calls) is the active provider agent's planning decision");
    expect(agents).toContain("prefer useful independent coverage over worker count");
    expect(agents).toContain("reduce them first with ordinary deterministic tools/code where practical");
  });

  it("does not introduce a runtime orchestration abstraction", () => {
    for (const forbidden of ["class Reducer", "class Graph", "class Node", "class Edge", "TaskGraph", "WorkflowEngine"]) {
      expect(agents).not.toContain(forbidden);
    }
  });

  it("makes independent review explicitly adversarial while preserving repair/reverify semantics and no fixed retry count", () => {
    expect(agents).toContain("reviewer's job is adversarial, not confirmatory");
    expect(agents).toContain("repair → reverify → re-review");
    expect(agents).toContain("do not impose a fixed retry count");
  });
});
