/**
 * PURPOSE: Per-chat CLI fallback chain for interactive provider execution.
 * Tracks which CLI is active for each chat. When a CLI is exhausted,
 * advance() moves to the next CLI in the chain. Conversation turns and
 * context injection are owned by BridgeEngine (single recorder/injector).
 * NEIGHBORS: src/index-interactive.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";

export class ProviderFallbackChain {
  private readonly chain: string[];
  private readonly chatActiveIdx = new Map<string, number>();
  private readonly db: BridgeDb;
  private readonly surfaceIdentity: string;
  private readonly isCliAvailable: (cli: string) => boolean;

  constructor(chain: string[], db: BridgeDb, surfaceIdentity: string, isCliAvailable: (cli: string) => boolean = () => true) {
    this.chain = chain;
    this.db = db;
    this.surfaceIdentity = surfaceIdentity;
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
    // Preserve the historical return type if a caller supplies no available
    // provider. Production routing injects canonical interactive availability.
    return this.chain[idx];
  }

  private clearUnavailableGatedPreference(chatKey: string, cli: "grok" | "cursor"): void {
    try {
      this.db.raw
        .prepare(`UPDATE bridge_state SET interactive_cli_preference = NULL WHERE surface_identity = ? AND chat_id = ? AND interactive_cli_preference = ?`)
        .run(this.surfaceIdentity, chatKey, cli);
    } catch { /* preference column may not exist on non-interactive test DBs */ }
  }

  setActiveCli(chatKey: string, cli: string): void {
    // Discord writes the preference before calling this method. Reject and scrub
    // unavailable status-gated providers before chain membership is checked.
    if ((cli === "grok" || cli === "cursor") && !this.isCliAvailable(cli)) {
      this.clearUnavailableGatedPreference(chatKey, cli);
      return;
    }
    const idx = this.chain.indexOf(cli);
    if (idx === -1 || !this.isCliAvailable(cli)) return;
    this.chatActiveIdx.set(chatKey, idx);
  }

  /**
   * Read-only variant of getActiveCli: finds the active CLI from a chat's
   * current position without ever writing chatActiveIdx. Status/list reads
   * must use this — mutating here races with a real attempt's own advance()
   * and can cause it to skip a valid fallback (#1114 P0).
   */
  peekActiveCli(chatKey: string): string | null {
    const idx = Math.min(this.chatActiveIdx.get(chatKey) ?? 0, this.chain.length - 1);
    for (let candidate = idx; candidate < this.chain.length; candidate += 1) {
      if (this.isCliAvailable(this.chain[candidate])) return this.chain[candidate];
    }
    for (let candidate = 0; candidate < idx; candidate += 1) {
      if (this.isCliAvailable(this.chain[candidate])) return this.chain[candidate];
    }
    return null;
  }

  /** Shared provider-selection decision for messaging and outward ACP.
   * Interactive turns may start from a user preference; therefore their
   * untried search starts at the configured head. Surface-neutral Turns pass
   * the actual failed provider as an anchor to preserve forward-only order.
   * Mutations occur only on a dispatch transition, never on status reads. */
  nextUntriedAvailable(chatKey: string, tried: ReadonlySet<string>, afterProvider?: string): string | null {
    const anchor = afterProvider === undefined ? -1 : this.chain.indexOf(afterProvider);
    if (afterProvider !== undefined && anchor === -1) return null;
    for (let idx = anchor + 1; idx < this.chain.length; idx += 1) {
      const cli = this.chain[idx];
      if (!tried.has(cli) && this.isCliAvailable(cli)) {
        this.chatActiveIdx.set(chatKey, idx);
        return cli;
      }
    }
    return null;
  }

  /**
   * Advance to the next available CLI. Returns null if none remains.
   * When `fromProvider` is given, advancement is anchored to that provider's
   * position in the chain — the provider that actually attempted and
   * failed — rather than to chatActiveIdx, which a concurrent read-only peek
   * must never move but previously did (#1114 P0).
   */
  advance(chatKey: string, fromProvider?: string): string | null {
    const currentIdx = fromProvider !== undefined ? this.chain.indexOf(fromProvider) : (this.chatActiveIdx.get(chatKey) ?? 0);
    if (currentIdx === -1) return null;
    return this.nextUntriedAvailable(chatKey, new Set<string>(), this.chain[currentIdx]);
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
