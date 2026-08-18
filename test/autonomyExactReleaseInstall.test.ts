import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("autonomous-work exact-release convergence (#466)", () => {
  it("is mandatory for non-opt-out exact-release skill selections", () => {
    const source = readFileSync("scripts/agent-bridge-install.py", "utf8");
    expect(source).toContain('"autonomous-work",');
    expect(source).toContain('if "autonomous-work" not in skills:');
    expect(source).toContain('skills.append("autonomous-work")');
    expect(source).toContain('str(manager),');
    expect(source).toContain('"install", skill, "--force"');
    expect(source).toContain('*command_prefix, "verify", skill');
  });

  it("preserves generic autonomy settings through exact-release installation", () => {
    const source = readFileSync("scripts/agent-bridge-install.py", "utf8");
    for (const key of [
      "AGENT_BRIDGE_AUTONOMY_DIR",
      "AGENT_BRIDGE_AUTONOMY_DB_PATH",
      "AGENT_BRIDGE_AUTONOMY_MAX_CYCLES",
    ]) expect(source).toContain(`"${key}"`);
  });
});
