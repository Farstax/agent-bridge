import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { cursorAcpPolicy } from "../src/providers/cursorAcpPolicy.js";
import { isCursorAuthenticated, isCursorRouteable } from "../src/providers/cursorAvailability.js";
import { runDoctor } from "../src/providers/doctor.js";
import {
  CURSOR_SKILL_DISCOVERY_NOTE,
  installSkillGlobal,
  projectManagedSkillToCursor,
  resolveSkillPaths,
} from "../src/skills.js";
import { projectUserSkillGlobal } from "../src/userSkills.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "edit files",
    sessionId: null,
    command: "cursor-agent",
    model: null,
    executionMode: "safe",
    outputFormat: "json",
    soulContext: null,
    attachments: [],
    outputDir: null,
    effort: null,
    toolMode: "default",
    ...overrides,
  };
}

describe("Cursor review regressions", () => {
  it("maps execution through ACP stdio rather than native ask/trust flags", () => {
    const invocation = buildCliInvocation({
      bot: "cursor",
      prompt: "edit files",
      sessionId: null,
      command: "cursor-agent",
      executionMode: "safe",
      includeResponseContract: false,
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.args).toEqual(["acp"]);
    expect(invocation.args).not.toContain("--mode");
    expect(invocation.args).not.toContain("ask");
    expect(invocation.args).not.toContain("-p");
    expect(cursorAcpPolicy.sessionSettings?.(request({ executionMode: "trusted" }), {})).toEqual({ modeId: "default" });
  });

  it("does not parse native oneshot JSON as a Cursor ACP result", () => {
    expect(() => parseCliResult({
      bot: "cursor",
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "first",
        session_id: "sess-1",
      }) + "\n",
    })).toThrow(/ACP structured results/);
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
      // Only claim the configured provider (cursor) as installed. Other ACP
      // providers (codex/claude/grok/agy) are not configured in this chain;
      // faking their executables as present would force real version
      // inspection against binaries that don't exist in this sandbox,
      // reporting them "invalid" and incorrectly failing the overall report.
      // Match on the executable's basename, not a raw substring: a
      // worktree checkout directory can itself contain "cursor" in its
      // path (e.g. agent-bridge-738-cursor), which would otherwise make
      // every other provider's node_modules/.bin path match too.
      commandExists: (executable) => basename(executable).includes("cursor"),
      inspectVersion: () => "2026.09.08",
      inspectVoiceRuntime: () => ({ status: "ready", reasonCode: null }),
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

  it("documents CURSOR_API_KEY as a verified alternative to account auth, not a bare presence check", () => {
    const example = readFileSync(join(process.cwd(), ".env.cursor.example"), "utf8");
    expect(example).toMatch(/CURSOR_API_KEY/);
    expect(example).toMatch(/verified/i);
  });
});

describe("cursor managed install propagation", () => {
  it("propagates CURSOR_* runtime configuration through the installer SERVICE_KEYS", () => {
    const installer = readFileSync(join(process.cwd(), "scripts/agent-bridge-install.py"), "utf8");
    for (const key of ["CURSOR_ACP_COMMAND", "CURSOR_ACP_ARGS", "CURSOR_MODEL_PREFERENCE", "CURSOR_EFFORT", "CURSOR_PROJECT_DIR"]) {
      expect(installer).toContain(`"${key}"`);
    }
  });
});
