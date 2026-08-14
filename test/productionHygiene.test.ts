import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("production source hygiene", () => {
  const entrypoints = [
    "src/index-interactive.ts",
    "src/index-discord-interactive.ts",
  ];

  it("entrypoints do not record conversation turns (engine._rememberTurn is the single recorder)", () => {
    for (const file of entrypoints) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} duplicates engine turn recording`).not.toContain("fallbackChain.addTurn");
    }
  });

  it("entrypoints and dispatchers do not inject context preambles (engine injects context once per execution)", () => {
    for (const file of [...entrypoints, "src/interactiveBot.ts", "src/providerFallback.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} duplicates engine context injection`).not.toContain("buildContextPreamble");
      expect(source, `${file} duplicates engine context injection`).not.toContain("contextPreambles");
    }
  });
});

describe("Issue #135 Phase 2: single CLI process registry ownership", () => {
  it("only src/cliSupervisor.ts declares the process registry", () => {
    const files = readdirSync(join(process.cwd(), "src")).filter((f) => f.endsWith(".ts"));
    const owners = files.filter((f) => {
      const source = readFileSync(join(process.cwd(), "src", f), "utf8");
      return /activeExecutions\s*=\s*new Map/.test(source);
    });
    expect(owners).toEqual(["cliSupervisor.ts"]);
  });

  it("src/cli.ts does not spawn child processes directly", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(source).not.toMatch(/from ["']node:child_process["']/);
    expect(source).not.toContain("spawn(");
  });

  it("only src/cliSupervisor.ts exports runSupervisedProcess", () => {
    const files = readdirSync(join(process.cwd(), "src")).filter((f) => f.endsWith(".ts"));
    const owners = files.filter((f) => {
      const source = readFileSync(join(process.cwd(), "src", f), "utf8");
      return /export (async )?function runSupervisedProcess/.test(source);
    });
    expect(owners).toEqual(["cliSupervisor.ts"]);
  });

  it("src/cliSupervisor.ts stays provider-agnostic — no Codex/Agy argument-shape policy", () => {
    // normalizeCliArgs (Codex/Agy-specific flag reconstruction) lives in
    // src/cliArgNormalization.ts. The supervisor calls it but must not own it.
    const source = readFileSync(join(process.cwd(), "src/cliSupervisor.ts"), "utf8");
    expect(source).not.toMatch(/isCodex|isAgy/);
    expect(source).not.toContain("--skip-git-repo-check");
    expect(source).not.toContain("function normalizeCliArgs");
    expect(source).not.toMatch(/ANTIGRAVITY|antigravity|PlannerResponse|\bAGY\b|command\.includes\(/);
  });
});

describe("Issue #135 Phase 3A: validateBridgeConfig ownership", () => {
  it("only src/config.ts defines validateBridgeConfig", () => {
    const files = readdirSync(join(process.cwd(), "src")).filter((f) => f.endsWith(".ts"));
    const owners = files.filter((f) => {
      const source = readFileSync(join(process.cwd(), "src", f), "utf8");
      return /export function validateBridgeConfig/.test(source);
    });
    expect(owners).toEqual(["config.ts"]);
  });

  it("validateBridgeConfig no longer takes an untyped 'any' parameter", () => {
    const source = readFileSync(join(process.cwd(), "src/config.ts"), "utf8");
    expect(source).toMatch(/function validateBridgeConfig\(config: (?!any\b)/);
  });
});

describe("Issue #135 Phase 3B: codex/claude runtime ownership", () => {
  it("src/cli.ts no longer defines Codex/Claude argument-shape branches (moved to src/providers/)", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    // Codex-specific: the disabled-tool-set flags and --skip-git-repo-check
    // only ever appeared inside the codex branch of buildCliInvocation.
    expect(source).not.toContain("guardian_approval");
    expect(source).not.toContain("--skip-git-repo-check");
    // Claude-specific: the stream-json attachment path and --disable-slash-commands
    // only ever appeared inside the claude branch of buildCliInvocation.
    expect(source).not.toContain("stream-json");
    expect(source).not.toContain("--disable-slash-commands");
    // Result parsing: Codex's thread.started/response.completed handling and
    // Claude's session_id JSON-result handling only ever appeared in
    // parseCodexResult/parseClaudeResult.
    expect(source).not.toContain("thread.started");
    expect(source).not.toContain("obj.session_id");
  });

  it("buildCliInvocation dispatches codex/claude to their provider runtime modules", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(source).toMatch(/bot === "codex"[\s\S]{0,80}codexRuntime\.buildInvocation/);
    expect(source).toMatch(/bot === "claude"[\s\S]{0,80}claudeRuntime\.buildInvocation/);
  });

  it("parseCliResult dispatches codex/claude to their provider runtime modules", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(source).toContain("codexRuntime.parseResult(stdout)");
    expect(source).toContain("claudeRuntime.parseResult(stdout)");
  });

});

describe("Issue #135 Phase 3C: antigravity/kimchi runtime ownership", () => {
  it("src/cli.ts no longer defines Antigravity/Kimchi argument-shape branches or result-parsing markers (moved to src/providers/)", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    // Antigravity-specific: --print-timeout/--conversation only ever appeared
    // in the antigravity branch of buildCliInvocation; the *** delimiter and
    // 🧠 Memory Loaded: markers only ever appeared in parseAntigravityResult.
    expect(source).not.toContain("--print-timeout");
    expect(source).not.toContain("--conversation");
    expect(source).not.toContain("🧠 Memory Loaded");
    expect(source).not.toContain("agent executor error:");
    // Kimchi-specific: --no-session and the thought/tool-call stripping
    // markers only ever appeared in the kimchi branch/parseKimchiResult.
    expect(source).not.toContain("--no-session");
    expect(source).not.toContain("thought_section_begin");
  });

  it("buildCliInvocation dispatches antigravity/kimchi to their provider runtime modules", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(source).toMatch(/bot === "antigravity"[\s\S]{0,80}antigravityRuntime\.buildInvocation/);
    expect(source).toMatch(/bot === "kimchi"[\s\S]{0,80}kimchiRuntime\.buildInvocation/);
  });

  it("parseCliResult dispatches antigravity/kimchi to their provider runtime modules", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(source).toContain("antigravityRuntime.parseResult(stdout, logContent)");
    expect(source).toContain("kimchiRuntime.parseResult(stdout)");
  });
});

describe("Issue #135 Phase 3: all four provider runtimes own buildInvocation and parseResult", () => {
  it("exactly codexRuntime/claudeRuntime/antigravityRuntime/kimchiRuntime export buildInvocation", () => {
    const dir = join(process.cwd(), "src/providers");
    const owners = readdirSync(dir).filter((f) => {
      if (!f.endsWith(".ts")) return false;
      const source = readFileSync(join(dir, f), "utf8");
      return /export function buildInvocation/.test(source);
    });
    expect(owners.sort()).toEqual(["antigravityRuntime.ts", "claudeRuntime.ts", "codexRuntime.ts", "kimchiRuntime.ts"]);
  });

  it("exactly codexRuntime/claudeRuntime/antigravityRuntime/kimchiRuntime export parseResult", () => {
    const dir = join(process.cwd(), "src/providers");
    const owners = readdirSync(dir).filter((f) => {
      if (!f.endsWith(".ts")) return false;
      const source = readFileSync(join(dir, f), "utf8");
      return /export function parseResult/.test(source);
    });
    expect(owners.sort()).toEqual(["antigravityRuntime.ts", "claudeRuntime.ts", "codexRuntime.ts", "kimchiRuntime.ts"]);
  });

  it("src/cli.ts's buildCliInvocation and parseCliResult are pure dispatchers for all four bot kinds", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    for (const bot of ["codex", "claude", "antigravity", "kimchi"]) {
      expect(source, `${bot} buildInvocation dispatch`).toMatch(new RegExp(`bot === "${bot}"[\\s\\S]{0,100}${bot}Runtime\\.buildInvocation`));
      expect(source, `${bot} parseResult dispatch`).toContain(`${bot}Runtime.parseResult(`);
    }
  });

  it("src/cli.ts does not encode a provider-name allow-list or tool-free capability matrix", () => {
    // CTO review on PR #144: ALLOWED_TOOL_FREE_BOTS was provider-specific
    // policy (which bots support toolMode:"none") sitting directly in the
    // dispatcher. That capability now lives in the provider registry
    // (src/providers/registry.ts), not as a hardcoded Set/allow-list in
    // cli.ts.
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(source).not.toMatch(/ALLOWED_TOOL_FREE_BOTS/);
    expect(source).not.toMatch(/new Set\(\s*\[\s*["']claude["']/);
  });
});

describe("Issue #135 Phase 3D: settings and compatibility ownership", () => {
  it("Claude settings environment parsing has one owner", () => {
    const files = readdirSync(join(process.cwd(), "src"), { recursive: true })
      .filter((file): file is string => file.endsWith(".ts"));
    const envOwners = files.filter((file) => readFileSync(join(process.cwd(), "src", file), "utf8").includes("CLAUDE_EXCLUDED_PLUGINS"));
    expect(envOwners).toEqual(["claudeSettings.ts"]);
    const settingsOwners = files.filter((file) => /function\s+(resolveClaudeSettings|buildClaudeSettingsJson|buildClaudeSettingsArg|describeClaudeSettings)\s*\(/.test(readFileSync(join(process.cwd(), "src", file), "utf8")));
    expect(settingsOwners).toEqual(["claudeSettings.ts"]);
  });

  it("bridge.ts exposes only named compatibility surfaces, never wildcard implementation barrels", () => {
    const source = readFileSync(join(process.cwd(), "src/bridge.ts"), "utf8");
    expect(source).not.toMatch(/export\s+\*\s+from/);
    expect(source).not.toContain("runSupervisedProcess");
    expect(source).not.toContain("activeExecutions");
  });
});
