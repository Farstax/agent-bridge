/**
 * Tests for ProviderFallbackChain — per-chat CLI fallback state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { openDb, BridgeDb } from "../src/db.js";

describe("ProviderFallbackChain", () => {
  let db: BridgeDb;
  let chain: ProviderFallbackChain;

  beforeEach(() => {
    db = openDb(":memory:");
    chain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db, "telegram:interactive",
         () => true);
  });

  describe("getActiveCli", () => {
    it("returns the first CLI in the chain by default", () => {
      expect(chain.getActiveCli("chat:1")).toBe("codex");
    });

    it("returns a different active CLI for different chat keys", () => {
      chain.advance("chat:1");
      expect(chain.getActiveCli("chat:1")).toBe("claude");
      expect(chain.getActiveCli("chat:2")).toBe("codex");
    });

    it("does not exceed chain bounds after multiple advances", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive",
         () => true);
      c.advance("chat:1");
      c.advance("chat:1"); // beyond end — should clamp to last
      expect(c.getActiveCli("chat:1")).toBe("claude");
    });
  });

  describe("advance", () => {
    it("returns the next CLI in the chain", () => {
      expect(chain.advance("chat:1")).toBe("claude");
    });

    it("returns null when already at the last CLI", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive",
         () => true);
      c.advance("chat:1"); // now at claude
      expect(c.advance("chat:1")).toBeNull(); // exhausted
    });

    it("advancing one chat does not affect another", () => {
      chain.advance("chat:1");
      expect(chain.getActiveCli("chat:2")).toBe("codex");
    });
  });

  describe("getChain", () => {
    it("returns a copy of the fallback chain array", () => {
      const chainList = ["codex", "claude", "antigravity"];
      const c = new ProviderFallbackChain(chainList, db, "telegram:interactive",
         () => true);
      expect(c.getChain()).toEqual(chainList);
      expect(c.getChain()).not.toBe(chainList);
    });
  });

  describe("isChainExhausted", () => {
    it("returns false when not at the last CLI", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive",
         () => true);
      expect(c.isChainExhausted("chat:1")).toBe(false);
    });

    it("returns true when at the last CLI", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive",
         () => true);
      c.advance("chat:1");
      expect(c.isChainExhausted("chat:1")).toBe(true);
    });

    it("returns true for a single-item chain", () => {
      const c = new ProviderFallbackChain(["codex"], db, "telegram:interactive",
         () => true);
      expect(c.isChainExhausted("chat:1")).toBe(true);
    });
  });

  describe("peekActiveCli (#1114 P0)", () => {
    it("never mutates chatActiveIdx even when the current head is unavailable", () => {
      const availability = new Set(["codex", "claude", "antigravity"]);
      const c = new ProviderFallbackChain(["codex", "claude", "antigravity"], db, "telegram:interactive",
        (cli) => availability.has(cli));
      availability.delete("codex");
      expect(c.peekActiveCli("chat:1")).toBe("claude");
      // A subsequent advance() anchored to codex (the real attempt) must still
      // see codex as the current position, proving the peek above did not
      // write chatActiveIdx.
      expect(c.advance("chat:1", "codex")).toBe("claude");
    });
  });

  describe("advance anchored to the failed provider (#1114 P0)", () => {
    it("advances from the given provider's position, ignoring a stale chatActiveIdx", () => {
      const c = new ProviderFallbackChain(["codex", "claude", "antigravity"], db, "telegram:interactive",
        () => true);
      // Simulate chatActiveIdx having been shifted elsewhere (e.g. by a
      // concurrent read) while codex is the provider actually in flight.
      c.setActiveCli("chat:1", "antigravity");
      expect(c.advance("chat:1", "codex")).toBe("claude");
    });

    it("returns null when the anchored provider is unknown", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive",
        () => true);
      expect(c.advance("chat:1", "not-a-provider")).toBeNull();
    });
  });

  describe("resetToHead", () => {
    it("resets the active CLI back to the first in the chain", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive",
         () => true);
      c.advance("chat:1");
      c.resetToHead("chat:1");
      expect(c.getActiveCli("chat:1")).toBe("codex");
    });
  });
});
