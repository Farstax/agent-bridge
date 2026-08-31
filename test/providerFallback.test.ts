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
    chain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db, () => true);
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
      const c = new ProviderFallbackChain(["codex", "claude"], db, () => true);
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
      const c = new ProviderFallbackChain(["codex", "claude"], db, () => true);
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
      const c = new ProviderFallbackChain(chainList, db, () => true);
      expect(c.getChain()).toEqual(chainList);
      expect(c.getChain()).not.toBe(chainList);
    });
  });

  describe("isChainExhausted", () => {
    it("returns false when not at the last CLI", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, () => true);
      expect(c.isChainExhausted("chat:1")).toBe(false);
    });

    it("returns true when at the last CLI", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, () => true);
      c.advance("chat:1");
      expect(c.isChainExhausted("chat:1")).toBe(true);
    });

    it("returns true for a single-item chain", () => {
      const c = new ProviderFallbackChain(["codex"], db, () => true);
      expect(c.isChainExhausted("chat:1")).toBe(true);
    });
  });

  describe("resetToHead", () => {
    it("resets the active CLI back to the first in the chain", () => {
      const c = new ProviderFallbackChain(["codex", "claude"], db, () => true);
      c.advance("chat:1");
      c.resetToHead("chat:1");
      expect(c.getActiveCli("chat:1")).toBe("codex");
    });
  });
});
