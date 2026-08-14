/**
 * PURPOSE: Per-chat CLI fallback chain for interactive provider execution.
 * Tracks which CLI is active for each chat. When a CLI is exhausted,
 * advance() moves to the next CLI in the chain. Conversation turns and
 * context injection are owned by BridgeEngine (single recorder/injector).
 * NEIGHBORS: src/index-interactive.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";
import { getQualificationFailedProviders } from "./providers/qualificationStatus.js";
import type { ProviderId } from "./providers/types.js";

function providerIdForCli(cli: string): ProviderId | null {
  if (cli === "antigravity" || cli === "agy") return "agy";
  if (cli === "codex" || cli === "claude" || cli === "kimchi") return cli;
  return null;
}

function qualificationAllowsCli(cli: string): boolean {
  const providerId = providerIdForCli(cli);
  return providerId == null || !getQualificationFailedProviders().has(providerId);
}

export class ProviderFallbackChain {
  private readonly chain: string[];
  private readonly chatActiveIdx = new Map<string, number>();
  private readonly db: BridgeDb;
  private readonly isCliAvailable: (cli: string) => boolean;

  constructor(chain: string[], db: BridgeDb, isCliAvailable: (cli: string) => boolean = qualificationAllowsCli) {
    this.chain = chain;
    this.db = db;
    this.isCliAvailable = isCliAvailable;
  }

  getChain(): string[] {
    return this.chain.filter((cli) => this.isCliAvailable(cli));
  }

  getActiveCli(chatKey: string): string {
    const idx = Math.min(this.chatActiveIdx.get(chatKey) ?? 0, this.chain.length - 1);
    for (let candidate = idx; candidate < this.chain.length; candidate += 1) {
      if (!this.isCliAvailable(this.chain[candidate])) continue;
      if (candidate !== idx) this.chatActiveIdx.set(chatKey, candidate);
      return this.chain[candidate];
    }
    for (let candidate = 0; candidate < idx; candidate += 1) {
      if (!this.isCliAvailable(this.chain[candidate])) continue;
      this.chatActiveIdx.set(chatKey, candidate);
      return this.chain[candidate];
    }
    // Preserve the historical return type when every configured provider is
    // unavailable; admission/routing layers surface the terminal condition.
    return this.chain[idx];
  }

  setActiveCli(chatKey: string, cli: string): void {
    const idx = this.chain.indexOf(cli);
    if (idx !== -1) {
      this.chatActiveIdx.set(chatKey, idx);
    }
  }

  /** Advance to the next available CLI. Returns null if none remains. */
  advance(chatKey: string): string | null {
    const currentIdx = this.chatActiveIdx.get(chatKey) ?? 0;
    for (let nextIdx = currentIdx + 1; nextIdx < this.chain.length; nextIdx += 1) {
      if (!this.isCliAvailable(this.chain[nextIdx])) continue;
      this.chatActiveIdx.set(chatKey, nextIdx);
      return this.chain[nextIdx];
    }
    return null;
  }

  isChainExhausted(chatKey: string): boolean {
    const currentIdx = this.chatActiveIdx.get(chatKey) ?? 0;
    for (let nextIdx = currentIdx + 1; nextIdx < this.chain.length; nextIdx += 1) {
      if (this.isCliAvailable(this.chain[nextIdx])) return false;
    }
    return true;
  }

  resetToHead(chatKey: string): void {
    this.chatActiveIdx.delete(chatKey);
  }
}
