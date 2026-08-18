import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("autonomy runtime configuration (#466)", () => {
  it("documents only the generic dir/db/max-cycle settings with default 3", () => {
    const env = readFileSync(".env.shared.example", "utf8");
    expect(env).toContain("AGENT_BRIDGE_AUTONOMY_DIR=");
    expect(env).toContain("AGENT_BRIDGE_AUTONOMY_DB_PATH=");
    expect(env).toContain("AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3");
    expect(env).not.toContain("FARSTAX");
  });
});
