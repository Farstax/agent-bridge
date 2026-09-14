import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Antigravity conversation isolation", () => {
  it("does not keep native log/cache session inference after ACP migration", () => {
    expect(existsSync("src/providers/antigravityRuntime.ts")).toBe(false);
    const engine = readFileSync("src/engine.ts", "utf8");
    expect(engine).not.toContain("resolveAntigravityConversationId");
    expect(engine).not.toContain("readAntigravityLastConversation");
    expect(engine).not.toContain("readLatestAntigravityConversationFromLogs");
  });
});
