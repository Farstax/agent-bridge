import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTelegramRuntimePolicy } from "../src/providerLock.js";

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
    });
  });

  it.each([
    ["claude", "TELEGRAM_BOT_TOKEN_CLAUDE", "claude-token"],
    ["codex", "TELEGRAM_BOT_TOKEN_CODEX", "codex-token"],
    ["antigravity", "TELEGRAM_BOT_TOKEN_ANTIGRAVITY", "agy-token"],
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
