import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIsolatedAdvisorFallbackSmoke } from "../scripts/smoke-advisor-fallback.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCodex(): string {
  const dir = mkdtempSync(join(tmpdir(), "advisor-smoke-fake-codex-"));
  dirs.push(dir);
  const command = join(dir, "codex");
  const selection = JSON.stringify({
    hypothesis: "Inspect the isolated repository status.",
    tool_requests: [{ tool: "git.status" }],
    missing_evidence: [],
  });
  const advice = JSON.stringify({
    advice_md: "Fallback is isolated.",
    risks: [],
    suggested_next_steps: ["Keep the smoke isolated."],
    confidence: "high",
  });
  writeFileSync(command, [
    "#!/usr/bin/env node",
    'const { readFileSync } = require("node:fs");',
    'const prompt = `${process.argv.slice(2).join(" ")}\n${readFileSync(0, "utf8")}`;',
    `const text = prompt.includes("Select only the minimum read-only evidence") ? ${JSON.stringify(selection)} : ${JSON.stringify(advice)};`,
    'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}})+"\\n");',
  ].join("\n"));
  chmodSync(command, 0o700);
  return command;
}

describe("isolated advisor fallback smoke", () => {
  it("refuses to run without the explicit isolated gate", async () => {
    await expect(runIsolatedAdvisorFallbackSmoke({ isolated: false, codexCommand: fakeCodex() }))
      .rejects.toThrow(/--isolated/);
  });

  it("exercises broker capability fallback while keeping Codex safe and tool-free", async () => {
    const result = await runIsolatedAdvisorFallbackSmoke({
      isolated: true,
      codexCommand: fakeCodex(),
      inheritedEnv: {
        PATH: process.env.PATH,
        TELEGRAM_BOT_TOKEN_INTERACTIVE: "must-not-leak",
        BRIDGE_ADVISOR_CHAIN: "must-not-leak",
        AGENT_BRIDGE_ADVISOR_CAPABILITY: "must-not-leak",
        BRIDGE_PRIVATE_TOKEN: "must-not-leak",
      },
    });

    expect(result.logicalCalls).toBe(1);
    expect(result.attempts).toEqual([
      expect.objectContaining({ ordinal: 1, provider: "claude", model: "claude-opus-5", status: "failed", error_kind: "capacity_exhausted" }),
      expect.objectContaining({ ordinal: 2, provider: "codex", model: "gpt-5.6-sol", status: "succeeded" }),
      expect.objectContaining({ ordinal: 3, provider: "claude", model: "claude-opus-5", status: "failed", error_kind: "capacity_exhausted" }),
      expect.objectContaining({ ordinal: 4, provider: "codex", model: "gpt-5.6-sol", status: "succeeded" }),
    ]);
    expect(result.selectedProvider).toBe("codex");
    expect(result.selectedModel).toBe("gpt-5.6-sol");
    expect(result.advisorChild).toBe(true);
    expect(result.codexArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    for (const tool of ["shell_tool", "browser_use", "computer_use", "plugins", "guardian_approval", "hooks", "goals", "apps"]) {
      expect(result.codexArgs).toContain(tool);
    }
    expect(result.forbiddenEnvKeys).toEqual([]);
    expect(result.repoClean).toBe(true);
    expect(result.canaryUnchanged).toBe(true);
  });

  it("resolves a bare Codex command through PATH", async () => {
    const command = fakeCodex();
    const result = await runIsolatedAdvisorFallbackSmoke({
      isolated: true,
      codexCommand: "codex",
      inheritedEnv: {
        PATH: `${dirname(command)}:${process.env.PATH}`,
      },
    });

    expect(result.selectedProvider).toBe("codex");
    expect(result.attempts).toHaveLength(4);
  });
});
