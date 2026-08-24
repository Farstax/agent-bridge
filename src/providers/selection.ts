/**
 * PURPOSE: Shared CLI/provider chain selection (Epic 11, issue #51).
 * Single owner of fallback-chain parsing for Companion Runtime
 * interactive provider chains. Chain vocabulary uses CLI kinds;
 * "antigravity" maps to provider id "agy".
 * NEIGHBORS: src/providers/registry.ts,
 * src/index-interactive.ts
 */

import { getProviderAdapters } from "./registry.js";
import type { ChainCliKind, ProviderId } from "./types.js";

const PROVIDER_TO_CHAIN_KIND: Record<ProviderId, ChainCliKind> = {
  codex: "codex",
  claude: "claude",
  agy: "antigravity",
  grok: "grok",
  cursor: "cursor",
};

/** CLI kinds usable in companion interactive chains, in registry order. */
export function interactiveChainKinds(): ChainCliKind[] {
  return getProviderAdapters()
    .filter((a) => a.capabilities.interactive)
    .map((a) => PROVIDER_TO_CHAIN_KIND[a.id]);
}

/**
 * Parses a comma-separated chain string: trims entries, drops empties and
 * entries outside `allowed`, and returns `fallback` when nothing survives.
 */
export function parseCliChain<K extends ChainCliKind>(
  raw: string | undefined,
  { allowed, fallback }: { allowed: readonly K[]; fallback: readonly K[] },
): K[] {
  const allowedSet = new Set<string>(allowed);
  const parsed = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is K => allowedSet.has(s));
  return parsed.length > 0 ? parsed : [...fallback];
}
