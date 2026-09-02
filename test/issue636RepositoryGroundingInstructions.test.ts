import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCliWorkingDir } from "../src/bridge.js";
import { isCursorRouteable } from "../src/providers/cursorAvailability.js";
import { isGrokRouteable } from "../src/providers/grokAvailability.js";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("Issue #636 native repository grounding", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("makes native source inspection the canonical implementation-explanation invariant", () => {
    const agents = readRepoFile("AGENTS.md");

    expect(agents).toContain("### Repository-grounded implementation explanations");
    expect(agents).toContain("inspect the relevant implementation source with the active provider's native repository/search/file tools before describing it");
    expect(agents).toContain("Prefer verified implementation over plausible inference");
    expect(agents).toContain("use retained conversation context only to locate likely areas, not as evidence for current implementation");
  });

  it.each([
    ["CLAUDE.md", "Claude"],
    ["ANTIGRAVITY.md", "Agy"],
  ])("routes %s implementation-specific questions through the canonical AGENTS invariant", (path) => {
    const providerNotes = readRepoFile(path);

    expect(providerNotes).toContain("repository-grounded implementation explanations");
    expect(providerNotes).toContain("answering implementation-specific questions");
    expect(providerNotes).toContain("`AGENTS.md` is authoritative");
  });

  it.each([
    ["codex" as const, "CODEX_PROJECT_DIR", "/tmp/issue636-codex"],
    ["claude" as const, "CLAUDE_PROJECT_DIR", "/tmp/issue636-claude"],
    ["antigravity" as const, "ANTIGRAVITY_PROJECT_DIR", "/tmp/issue636-agy"],
    ["grok" as const, "GROK_PROJECT_DIR", "/tmp/issue636-grok"],
    ["cursor" as const, "CURSOR_PROJECT_DIR", "/tmp/issue636-cursor"],
  ])("keeps %s native CLI execution rooted in its configured repository working directory", (kind, envName, expected) => {
    vi.stubEnv(envName, expected);
    if (kind === "grok" && !isGrokRouteable()) return;
    if (kind === "cursor" && !isCursorRouteable()) return;
    expect(getCliWorkingDir(kind)).toBe(expected);
  });
});
