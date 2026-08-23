import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGlobalInteractiveCommandRegistrations } from "../src/interactiveBot.js";
import { resolveAutonomyRuntimeConfig, resolveTelegramRuntimePolicy } from "../src/providerLock.js";

const cliChain = ["claude", "codex", "antigravity"] as const;

describe("Telegram provider lock", () => {
  it("keeps the interactive surface switchable when no provider is locked", () => {
    const policy = resolveTelegramRuntimePolicy(
      { TELEGRAM_BOT_TOKEN_INTERACTIVE: "interactive-token" },
      [...cliChain],
    );

    expect(policy).toEqual({
      providerLock: null,
      cliKinds: [...cliChain],
      token: "interactive-token",
      surfaceIdentity: "telegram:interactive",
      pollKind: "codex",
      cliSwitchingEnabled: true,
      databaseRole: "interactive",
      databaseServiceId: "telegram:interactive",
    });
  });

  it.each([
    ["claude", "TELEGRAM_BOT_TOKEN_CLAUDE", "claude-token"],
    ["codex", "TELEGRAM_BOT_TOKEN_CODEX", "codex-token"],
    ["antigravity", "TELEGRAM_BOT_TOKEN_ANTIGRAVITY", "agy-token"],
    ["grok", "TELEGRAM_BOT_TOKEN_GROK", "grok-token"],
  ] as const)("locks %s to one engine, token and poll cursor", (provider, tokenKey, token) => {
    const policy = resolveTelegramRuntimePolicy(
      {
        BRIDGE_PROVIDER_LOCK: provider,
        [tokenKey]: token,
        TELEGRAM_BOT_TOKEN_INTERACTIVE: "interactive-token",
      },
      [...cliChain],
    );

    expect(policy).toEqual({
      providerLock: provider,
      cliKinds: [provider],
      token,
      surfaceIdentity: `telegram:${provider}`,
      pollKind: provider,
      cliSwitchingEnabled: false,
      databaseRole: "shared",
      databaseServiceId: "telegram:standalone",
    });
  });

  it("keeps the legacy Gemini token alias for a locked Antigravity bot", () => {
    const policy = resolveTelegramRuntimePolicy(
      {
        BRIDGE_PROVIDER_LOCK: "antigravity",
        TELEGRAM_BOT_TOKEN_GEMINI: "legacy-agy-token",
      },
      [...cliChain],
    );

    expect(policy.token).toBe("legacy-agy-token");
  });

  it("fails closed for an unknown provider lock", () => {
    expect(() =>
      resolveTelegramRuntimePolicy(
        { BRIDGE_PROVIDER_LOCK: "other" },
        [...cliChain],
      ),
    ).toThrow(/BRIDGE_PROVIDER_LOCK/);
  });

  it("keeps configured autonomy on the unlocked interactive runtime", () => {
    const config = resolveAutonomyRuntimeConfig(
      {
        AGENT_BRIDGE_AUTONOMY_DIR: "/var/lib/agent-bridge/autonomy",
        AGENT_BRIDGE_AUTONOMY_DB_PATH: "/var/lib/agent-bridge/autonomy/autonomy.sqlite",
        AGENT_BRIDGE_AUTONOMY_MAX_CYCLES: "20",
      },
      null,
    );

    expect(config).toEqual({
      enabled: true,
      dir: "/var/lib/agent-bridge/autonomy",
      dbPath: "/var/lib/agent-bridge/autonomy/autonomy.sqlite",
      maxCycles: 20,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 5,
    });
    expect(
      buildGlobalInteractiveCommandRegistrations("codex", { autonomy: config.enabled })
        .every((registration) => registration.commands.some((command) => command.command === "autonomy")),
    ).toBe(true);
  });

  it.each(cliChain)("ignores inherited autonomy config for locked %s runtimes", (provider) => {
    const config = resolveAutonomyRuntimeConfig(
      {
        AGENT_BRIDGE_AUTONOMY_DIR: "relative-and-unpaired",
        AGENT_BRIDGE_AUTONOMY_MAX_CYCLES: "not-a-number",
      },
      provider,
    );

    expect(config).toEqual({
      enabled: false,
      dir: null,
      dbPath: null,
      maxCycles: 3,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 5,
    });
    expect(
      buildGlobalInteractiveCommandRegistrations(provider, { autonomy: config.enabled })
        .every((registration) => registration.commands.every((command) => command.command !== "autonomy")),
    ).toBe(true);
  });

  it("preserves autonomy validation for the unlocked interactive runtime", () => {
    expect(() => resolveAutonomyRuntimeConfig(
      { AGENT_BRIDGE_AUTONOMY_DIR: "/var/lib/agent-bridge/autonomy" },
      null,
    )).toThrow(/configured together/);
  });

  it("routes every Telegram systemd unit through the unified runtime with explicit locks", () => {
    const locked = ["claude", "codex", "antigravity"] as const;
    for (const provider of locked) {
      const unit = readFileSync(
        new URL(`../systemd/agent-bridge-${provider}.service`, import.meta.url),
        "utf8",
      );
      expect(unit, provider).toContain(`Environment=BRIDGE_PROVIDER_LOCK=${provider}`);
      expect(unit, provider).toContain("src/index-interactive.ts");
      expect(unit, provider).not.toContain("src/index.ts");
    }

    const interactive = readFileSync(
      new URL("../systemd/agent-bridge-interactive.service", import.meta.url),
      "utf8",
    );
    expect(interactive).toContain("src/index-interactive.ts");
    expect(interactive).not.toContain("BRIDGE_PROVIDER_LOCK=");
  });

  it("has no separate production Telegram provider entry point", () => {
    expect(existsSync(new URL("../src/index.ts", import.meta.url))).toBe(false);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.start).toBe("tsx src/index-interactive.ts");
  });
});
