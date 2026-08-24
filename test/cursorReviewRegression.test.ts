import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { isCursorAuthenticated, isCursorRouteable } from "../src/providers/cursorAvailability.js";
import { runDoctor } from "../src/providers/doctor.js";
import {
  CURSOR_SKILL_DISCOVERY_NOTE,
  installSkillGlobal,
  projectManagedSkillToCursor,
  resolveSkillPaths,
} from "../src/skills.js";
import { projectUserSkillGlobal } from "../src/userSkills.js";

function cursorStream(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

describe("cursor safe execution policy", () => {
  it("maps safe mode to Cursor ask mode with workspace trust for headless refusal of writes", () => {
    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "edit files",
      sessionId: null,
      command: "cursor-agent",
      executionMode: "safe",
      includeResponseContract: false,
    });
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).toContain("ask");
    expect(invocation.args).toContain("--trust");
    expect(invocation.args).not.toContain("--sandbox");
    expect(invocation.args).not.toContain("disabled");
  });

  it("keeps trusted mode on the qualified write-capable flags", () => {
    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "edit files",
      sessionId: null,
      command: "cursor-agent",
      executionMode: "trusted",
      includeResponseContract: false,
    });
    expect(invocation.args.slice(2)).toEqual([
      "--output-format", "json",
      "--trust",
      "--sandbox", "disabled",
    ]);
    expect(invocation.args).not.toContain("--mode");
  });
});

describe("cursor terminal parse fail-closed", () => {
  it("rejects events after a terminal result", () => {
    expect(() => parseCliResult({
      bot: "cursor",
      stdout: cursorStream([
        { type: "result", subtype: "success", is_error: false, result: "first", session_id: "sess-1" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "late" }] }, session_id: "sess-1" },
      ]),
    })).toThrow(/after terminal/i);
  });

  it("rejects a second terminal result", () => {
    expect(() => parseCliResult({
      bot: "cursor",
      stdout: cursorStream([
        { type: "result", subtype: "success", is_error: false, result: "first", session_id: "sess-1" },
        { type: "result", subtype: "success", is_error: false, result: "second", session_id: "sess-2" },
      ]),
    })).toThrow(/after terminal/i);
  });
});

describe("cursor skill projection policy", () => {
  it("does not auto-project managed skills into Cursor alongside Claude/Codex", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-skill-policy-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "cursor-skill-repo-"));
    const skillDir = join(repoRoot, "skills", "portable-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: portable-skill\ndescription: Portable skill used for compatibility testing.\n---\n\n# portable-skill\n",
    );

    installSkillGlobal("portable-skill", { repoRoot, homeDir: home });
    const paths = resolveSkillPaths(home);
    expect(existsSync(join(paths.claudeSkillsDir, "portable-skill"))).toBe(true);
    expect(existsSync(join(paths.cursorSkillsDir, "portable-skill"))).toBe(false);
    expect(CURSOR_SKILL_DISCOVERY_NOTE).toMatch(/does not auto-project/i);
  });

  it("projects to Cursor only through an explicit path and preserves unmanaged Cursor skills", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-skill-explicit-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "cursor-skill-repo-"));
    const skillDir = join(repoRoot, "skills", "portable-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: portable-skill\ndescription: Portable skill used for compatibility testing.\n---\n\n# portable-skill\n",
    );
    installSkillGlobal("portable-skill", { repoRoot, homeDir: home });

    const paths = resolveSkillPaths(home);
    mkdirSync(join(paths.cursorSkillsDir, "portable-skill"), { recursive: true });
    writeFileSync(join(paths.cursorSkillsDir, "portable-skill", "SKILL.md"), "# unmanaged\n");

    expect(() => projectManagedSkillToCursor("portable-skill", { homeDir: home })).toThrow(/not this managed projection/i);
    expect(readFileSync(join(paths.cursorSkillsDir, "portable-skill", "SKILL.md"), "utf8")).toContain("unmanaged");
  });

  it("prefights unmanaged Cursor skill collisions for user skill projection", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-user-skill-"));
    const paths = resolveSkillPaths(home);
    mkdirSync(join(paths.agentsSkillsDir, "my-review"), { recursive: true });
    writeFileSync(
      join(paths.agentsSkillsDir, "my-review", "SKILL.md"),
      "---\nname: my-review\ndescription: User-authored skill used for projection testing.\n---\n\n# my-review\n",
    );
    mkdirSync(join(paths.cursorSkillsDir, "my-review"), { recursive: true });
    writeFileSync(join(paths.cursorSkillsDir, "my-review", "SKILL.md"), "# unmanaged cursor skill\n");

    expect(() => projectUserSkillGlobal("my-review", { homeDir: home, repoRoot: home })).toThrow(/Native skill path already exists/i);
  });
});

describe("cursor doctor and session expiry", () => {
  it("accepts cursor in INTERACTIVE_CLI_CHAIN", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "cursor" },
      commandExists: () => true,
    });
    const chain = report.chains.find((entry) => entry.name === "INTERACTIVE_CLI_CHAIN");
    expect(chain?.ok).toBe(true);
    expect(chain?.unknown).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("expires stale Cursor sessions after seven days on open", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cursor-session-expiry-")), "bridge.sqlite");
    const first = openDb(dbPath);
    first.setSession("chat:1", "cursor", "sess-old");
    first.raw.prepare(
      `UPDATE bridge_state SET cursor_session_created_at = datetime('now', '-8 days') WHERE chat_id = ?`,
    ).run("chat:1");
    first.close();

    const second = openDb(dbPath);
    expect(second.getSession("chat:1", "cursor")).toBeNull();
    second.close();
  });
});

describe("cursor auth readiness", () => {
  it("treats status-authenticated Cursor as authenticated without relying on credential-file presence", () => {
    expect(isCursorAuthenticated({
      homeDir: "/no-cursor-home",
      exists: () => false,
      env: {},
      readStatus: () => ({ isAuthenticated: true }),
    })).toBe(true);
  });

  it("does not treat credential files alone as authenticated", () => {
    expect(isCursorAuthenticated({
      homeDir: "/cursor-home",
      exists: () => true,
      env: {},
      readStatus: () => {
        throw new Error("status unavailable");
      },
    })).toBe(false);
  });

  it("does not treat CURSOR_API_KEY as authenticated", () => {
    expect(isCursorAuthenticated({
      homeDir: "/no-cursor-home",
      exists: () => false,
      env: { CURSOR_API_KEY: "test-key" },
      readStatus: () => {
        throw new Error("status unavailable");
      },
    })).toBe(false);
  });

  it("is not routeable when status reports unauthenticated", () => {
    expect(isCursorRouteable({
      homeDir: "/no-cursor-home",
      exists: () => false,
      env: {},
      readStatus: () => ({ isAuthenticated: false }),
      failedProviders: new Set(),
    })).toBe(false);
  });

  it("does not mention CURSOR_API_KEY in Cursor env examples or docs", () => {
    const example = readFileSync(join(process.cwd(), ".env.cursor.example"), "utf8");
    const docs = readFileSync(join(process.cwd(), "docs/PROVIDER-QUALIFICATION.md"), "utf8");
    expect(example).not.toMatch(/CURSOR_API_KEY/);
    expect(docs).not.toMatch(/CURSOR_API_KEY/);
  });
});

describe("cursor managed install propagation", () => {
  it("propagates CURSOR_* runtime configuration through the installer SERVICE_KEYS", () => {
    const installer = readFileSync(join(process.cwd(), "scripts/agent-bridge-install.py"), "utf8");
    for (const key of ["CURSOR_COMMAND", "CURSOR_MODEL_PREFERENCE", "CURSOR_EFFORT", "CURSOR_PROJECT_DIR"]) {
      expect(installer).toContain(`"${key}"`);
    }
  });
});
