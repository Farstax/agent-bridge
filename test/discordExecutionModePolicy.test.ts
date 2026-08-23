import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Discord execution-mode policy", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/index-discord-interactive.ts"),
    "utf8",
  );

  it("resolves each provider mode through shared configuration", () => {
    expect(source).toContain("resolveExecutionMode(kind as BotKind, process.env)");
  });

  it("uses the shared resolver for the top-level default instead of casting raw env", () => {
    expect(source).toContain('const executionMode = resolveExecutionMode("codex", process.env);');
    expect(source).not.toContain('process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted"');
  });
});
