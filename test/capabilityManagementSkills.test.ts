import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("capability management skills", () => {
  it("teaches canonical user skill storage and existing projection commands", () => {
    const skill = read("skills/manage-skills/SKILL.md");
    expect(skill).toContain("~/.agents/skills/<skill-name>/SKILL.md");
    expect(skill).toContain("npm run skills -- project-user <name>");
    expect(skill).toContain("npm run skills -- verify <name>");
    expect(skill).toContain("bundled Skill");
  });

  it("keeps MCP configuration provider-native and credentials indirect", () => {
    const skill = read("skills/manage-mcp/SKILL.md");
    expect(skill).toContain("claude mcp");
    expect(skill).toContain("codex mcp");
    expect(skill).toContain("agy mcp");
    expect(skill).toContain("grok mcp");
    expect(skill).toContain("GROK_EXECUTION_MODE=trusted");
    expect(skill).toContain("long-running MCP");
    expect(skill).toContain("environment-variable name");
    expect(skill).toContain("model-mediated qualification");
    expect(skill).toContain("Playwright MCP `0.0.79`");
    expect(skill).not.toContain("CapabilityManager");
  });

  it("requires rendered headless verification for relevant UI work", () => {
    const skill = read("skills/ui-engineering/SKILL.md");
    expect(skill).toContain("Playwright MCP");
    expect(skill).toContain("headless Chromium");
    expect(skill).toContain("rendered page");
    expect(skill).toContain("console errors");
    expect(skill).toContain("failed network requests");
    expect(skill).toMatch(/reload/i);
  });

  it("retains exact live qualification provenance and residual gaps", () => {
    const evidence = read("docs/MCP-UI-QUALIFICATION.md");
    expect(evidence).toContain("69ad46365868245f148d6c18911e15c7a12088ba");
    expect(evidence).toContain("Claude Code `2.1.240`");
    expect(evidence).toContain("Codex CLI `0.149.0`");
    expect(evidence).toContain("Playwright MCP `0.0.79`");
    expect(evidence).toContain("82b8e22");
    expect(evidence).toContain("Agy `1.1.19`: MCP tool use and the Playwright headless UI loop passed");
    expect(evidence).toContain("agy mcp add/remove/list/enable/disable");
    expect(evidence).toContain("~/.gemini/config/mcp_config.json");
    expect(evidence).toContain("Grok Build `1.0.5`");
    expect(evidence).toContain("grok mcp add/remove/list/enable/disable/doctor");
    expect(evidence).toContain("~/.grok/config.toml");
    expect(evidence).toContain("GROK_EXECUTION_MODE=trusted");
    expect(evidence).toContain("earlier Agy `1.1.12`");
    expect(evidence).toContain("observation that MCP was unsupported is historical");
    expect(evidence).toContain("cancellation while an MCP tool call is actively running");
  });
});
