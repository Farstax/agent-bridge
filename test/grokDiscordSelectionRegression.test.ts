import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getUserCliPreference, setUserCliPreference } from "../src/interactiveBot.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";

describe("Discord Grok selection fail-closed boundary", () => {
  it("scrubs unavailable Grok even when the default fallback chain does not contain it", () => {
    const db = openDb(":memory:");
    setUserCliPreference(db, "discord:channel:1", "grok");
    const chain = new ProviderFallbackChain(
      ["codex", "claude", "antigravity"],
      db,
      (cli) => cli !== "grok",
    );

    chain.setActiveCli("discord:channel:1", "grok");

    expect(getUserCliPreference(db, "discord:channel:1")).toBe("codex");
    expect(chain.getActiveCli("discord:channel:1")).toBe("codex");
  });
});
