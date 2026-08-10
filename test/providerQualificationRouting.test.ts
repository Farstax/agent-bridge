import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getAvailableCliKinds } from "../src/interactiveCliAuth.js";
import { WorkerFallbackChain } from "../src/workerFallback.js";

describe("provider qualification routing", () => {
  it("excludes only providers with hard qualification failures from interactive selection", () => {
    const available = getAvailableCliKinds({
      homeDir: "/qualification-test-home",
      exists: () => true,
      commandExists: () => true,
      failedProviders: new Set(["codex", "agy"]),
    });

    expect([...available]).toEqual(["claude", "kimchi"]);
  });

  it("skips unavailable providers when advancing the fallback chain", () => {
    const db = openDb(":memory:");
    const chain = new WorkerFallbackChain(
      ["codex", "claude", "antigravity"],
      db,
      (cli) => cli !== "claude",
    );

    expect(chain.getChain()).toEqual(["codex", "antigravity"]);
    expect(chain.getActiveCli("chat:1")).toBe("codex");
    expect(chain.advance("chat:1")).toBe("antigravity");
    expect(chain.isChainExhausted("chat:1")).toBe(true);
  });

  it("moves the effective active provider past an unavailable chain head", () => {
    const db = openDb(":memory:");
    const chain = new WorkerFallbackChain(
      ["codex", "claude", "antigravity"],
      db,
      (cli) => cli !== "codex",
    );

    expect(chain.getActiveCli("chat:1")).toBe("claude");
    expect(chain.getChain()).toEqual(["claude", "antigravity"]);
  });
});
