import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Test the actual execution path logic by inspecting the source
describe("Execution Path Selection - TDD", () => {
  const selectionLogicPattern = /const useAsync = (.+);/;
  
  describe("Phase 2: Green - Required changes", () => {
    it("REMOVE: buildGeminiFallbackInvocation import", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.ts", "utf-8");
      
      // Should NOT import the fallback builder
      const hasImport = src.includes("buildGeminiFallbackInvocation");
      // This is now removed
      expect(hasImport).toBe(false);
    });

    it("keeps deprecated Gemini env aliases as Agy compatibility shims", async () => {
      const fs = await import("fs");
      const index = fs.readFileSync("src/index.ts", "utf-8");
      const bridge = fs.readFileSync("src/bridge.ts", "utf-8");
      // Bot env aliases moved from index.ts into the shared config module (Epic 1).
      const config = fs.readFileSync("src/config.ts", "utf-8");

      expect(config).toContain("TELEGRAM_BOT_TOKEN_GEMINI");
      expect(config).toContain("GEMINI_COMMAND");
      expect(config).toContain("GEMINI_MODEL_PREFERENCE");
      expect(index).toContain('name.includes("gemini")');
      expect(bridge).toContain("GEMINI_PROJECT_DIR");
    });

    it("timeout-based fallback removed; capacity-based fallback uses isCapacityExhaustedError", async () => {
      const fs = await import("fs");
      // Execution logic now lives in engine.ts (extracted from index.ts)
      const src = fs.readFileSync("src/engine.ts", "utf-8");

      // Old timeout-based fallback must be gone
      expect(src.includes("isCliTimeout(error)")).toBe(false);
      // New capacity-based fallback is intentionally present
      expect(src.includes("isCapacityExhaustedError")).toBe(true);
      expect(src.includes("getNextFallbackModel")).toBe(true);
    });

    it("REMOVE: kind-specific CLI args in cli", async () => {
      const fs = await import("fs");
      const cli = fs.readFileSync("src/cli.ts", "utf-8");
      
      // Still has both branches - will be unified next
      const hasCodex = cli.includes('if (bot === "codex")');
      const hasAntigravity = cli.includes('if (bot === "antigravity")');
      
      // Current: still has branches, but they should be unified
      expect(hasAntigravity && hasCodex).toBe(true);  // Baseline
    });
  });

  describe("Phase 3: Generic flag works for all bots", () => {
    it("useAsync assignment does not branch on bot kind", async () => {
      const fs = await import("fs");
      // Execution logic now lives in engine.ts (extracted from index.ts)
      const src = fs.readFileSync("src/engine.ts", "utf-8");

      // The async/sync execution mode must be set from config alone, not
      // per-bot-kind. The boolean useAsync flag (Phase 3) was later widened
      // into a three-state ContinuationExecutionMode ("async" | "sync") for
      // durable continuation (Issue #261); the derivation is still
      // config-only, so this assertion tracks the same invariant under the
      // renamed variable.
      const modeLine = src.split("\n").find((l) => l.includes("asyncEnabled === true ? \"async\" : \"sync\""));
      expect(modeLine).toBeDefined();
      expect(modeLine).not.toContain("this.kind");
      expect(modeLine).not.toContain('"gemini"');
    });

    it("documents the live Claude continuation output contract", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/engine.ts", "utf-8");

      expect(src).toContain("Claude continuation-capable turns request transcript-bearing stream JSON");
      expect(src).not.toContain("provider argv still requests JSON");
      expect(src).not.toContain("stream-json discriminator is bridge-internal");
    });
  });
});
describe("Idle Timeout Config", () => {
  it("buildExecutionOptions returns per-kind timeouts (antigravity idle/hard disabled by default)", async () => {
    const { buildExecutionOptions } = await import("../src/cli.js");
    const savedAntigravityIdle = process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS;
    const savedGlobalIdle = process.env.CLI_IDLE_TIMEOUT_MS;
    const savedAntigravityHard = process.env.ANTIGRAVITY_CLI_TIMEOUT_MS;
    const savedGlobalHard = process.env.CLI_TIMEOUT_MS;
    delete process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS;
    delete process.env.CLI_IDLE_TIMEOUT_MS;
    delete process.env.ANTIGRAVITY_CLI_TIMEOUT_MS;
    delete process.env.CLI_TIMEOUT_MS;
    try {
      const opts = buildExecutionOptions("antigravity");
      expect(opts.idleTimeoutMs).toBe(0);
      expect(opts.timeoutMs).toBe(0);
    } finally {
      if (savedAntigravityIdle !== undefined) process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS = savedAntigravityIdle;
      if (savedGlobalIdle !== undefined) process.env.CLI_IDLE_TIMEOUT_MS = savedGlobalIdle;
      if (savedAntigravityHard !== undefined) process.env.ANTIGRAVITY_CLI_TIMEOUT_MS = savedAntigravityHard;
      if (savedGlobalHard !== undefined) process.env.CLI_TIMEOUT_MS = savedGlobalHard;
    }
  });

  it("install script no longer runs legacy shared-memory setup", async () => {
    const fs = await import("fs");
    const installScript = fs.readFileSync("scripts/install.sh", "utf-8");
    expect(installScript).toContain('TARGET_USER="${SUDO_USER:-${USER}}"');
    expect(installScript).not.toContain("setup-shared-memory");
    expect(installScript).not.toContain("AGENT_MEMORY_DB_PATH");
    expect(installScript).toContain('sudo -u "${TARGET_USER}"');
  });

  it("install.sh supports non-interactive shared skill installation for the target home", async () => {
    const fs = await import("fs");
    const installScript = fs.readFileSync("scripts/install.sh", "utf-8");

    expect(installScript).toContain("AGENT_BRIDGE_SKILLS");
    expect(installScript).toContain("AGENT_BRIDGE_SKILL_LINK_MODE");
    expect(installScript).toContain("scripts/skill-manager.ts install");
    expect(installScript).toContain('SHARED_MEMORY_HOME="${TARGET_HOME}"');
  });
});
