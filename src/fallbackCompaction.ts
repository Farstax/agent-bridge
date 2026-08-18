/**
 * PURPOSE: Selects one healthy, tool-free provider for capacity-fallback
 * compaction and runs the shared database-owned compaction service.
 * NEIGHBORS: src/interactiveBot.ts, src/compactConversation.ts, src/index*.ts
 */

import type { BridgeDb } from "./db.js";
import {
  compactConversation,
  type CompactionFallbackTarget,
  type CompactConversationDeps,
  type CompactConversationResult,
} from "./compactConversation.js";
import type { CompactProfile } from "./compactSummary.js";
import type { BotConfig, BotKind } from "./types.js";
import {
  LEGACY_MEMORY_COMPACTION_DISABLED_MESSAGE,
  legacyMemoryCompactionEnabled,
} from "./legacyMemoryCompaction.js";

const TOOL_FREE_COMPACTION_PROVIDERS = new Set<BotKind>(["codex", "claude", "antigravity"]);

export interface CompactionTargetSpec {
  provider: BotKind;
  model: string | null;
}

export function resolveCompactionRecoveryTargets(input: {
  db: BridgeDb;
  activeProvider: BotKind;
  bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
  configuredChain: readonly CompactionTargetSpec[];
  exhaustedProviders?: readonly BotKind[];
}): CompactionFallbackTarget[] {
  const exhausted = new Set(input.exhaustedProviders ?? []);
  const seen = new Set<string>();
  const targets: CompactionFallbackTarget[] = [];
  for (const spec of [{ provider: input.activeProvider, model: null }, ...input.configuredChain]) {
    if (!TOOL_FREE_COMPACTION_PROVIDERS.has(spec.provider) || exhausted.has(spec.provider)) continue;
    const key = `${spec.provider}:${spec.model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const config = input.bots[spec.provider];
    targets.push({
      provider: spec.provider,
      command: config?.command ?? "",
      model: spec.model ?? input.db.getSetting(spec.provider) ?? config?.modelPreference[0] ?? null,
    });
  }
  return targets;
}

function recordPreflightFailure(db: BridgeDb, chatKey: string, provider: BotKind | "unavailable"): void {
  const at = new Date().toISOString();
  try {
    db.addCompactionAttempt({
      chatKey,
      trigger: "capacity_fallback",
      provider,
      model: null,
      outcome: "failed",
      errorCategory: "provider_unavailable",
      durationMs: 0,
      chunkCount: 0,
      cliCallCount: 0,
      rangeStartTurnId: null,
      rangeEndTurnId: null,
      startedAt: at,
      endedAt: at,
    });
  } catch {
    console.warn("[compaction-telemetry] write failed for capacity_fallback/failed");
  }
}

export interface CapacityFallbackCompactionRequest {
  chatKey: string;
  fromCli: BotKind;
  toCli: BotKind;
  exhaustedClis: readonly BotKind[];
}

export function parseCompactionProviderChain(raw: string | undefined): CompactionTargetSpec[] {
  const targets: CompactionTargetSpec[] = [];
  const seen = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const [rawProvider, rawModel, ...extra] = entry.trim().split(":");
    if (extra.length > 0) continue;
    const value = rawProvider === "agy" ? "antigravity" : rawProvider;
    if (!TOOL_FREE_COMPACTION_PROVIDERS.has(value as BotKind)) continue;
    const model = rawModel?.trim() || null;
    if (model && !/^[a-zA-Z0-9._/-]{1,128}$/.test(model)) continue;
    const provider = value as BotKind;
    const key = `${provider}:${model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ provider, model });
  }
  return targets;
}

export function selectCapacityFallbackCompactionTarget(input: {
  toCli: BotKind;
  exhaustedClis: readonly BotKind[];
  configuredChain: readonly CompactionTargetSpec[];
}): CompactionTargetSpec | null {
  const exhausted = new Set(input.exhaustedClis);
  return [{ provider: input.toCli, model: null }, ...input.configuredChain].find((target) =>
    TOOL_FREE_COMPACTION_PROVIDERS.has(target.provider) && !exhausted.has(target.provider)
  ) ?? null;
}

export async function runCapacityFallbackCompaction(
  request: CapacityFallbackCompactionRequest,
  deps: {
    db: BridgeDb;
    runCli: CompactConversationDeps["runCli"];
    bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
    configuredChain: readonly CompactionTargetSpec[];
    compactProfile: CompactProfile;
  },
): Promise<CompactConversationResult> {
  if (!legacyMemoryCompactionEnabled()) {
    return {
      outcome: "failed",
      trigger: "capacity_fallback",
      error: LEGACY_MEMORY_COMPACTION_DISABLED_MESSAGE,
    };
  }

  const exhausted = [...request.exhaustedClis, request.fromCli];
  const runtimeTargets = resolveCompactionRecoveryTargets({
    db: deps.db,
    activeProvider: request.toCli,
    bots: deps.bots,
    configuredChain: deps.configuredChain,
    exhaustedProviders: exhausted,
  });
  if (runtimeTargets.length === 0) {
    recordPreflightFailure(deps.db, request.chatKey, "unavailable");
    return {
      outcome: "failed",
      trigger: "capacity_fallback",
      error: "No healthy tool-free compaction provider is available",
    };
  }

  if (!runtimeTargets.some((target) => target.command.trim().length > 0)) {
    recordPreflightFailure(deps.db, request.chatKey, runtimeTargets[0].provider);
    return {
      outcome: "failed",
      trigger: "capacity_fallback",
      error: `Compaction provider unavailable: ${runtimeTargets[0].provider}`,
    };
  }

  const [primary, ...fallbackTargets] = runtimeTargets;
  return compactConversation(request.chatKey, {
    db: deps.db,
    runCli: deps.runCli,
    botConfig: { command: primary.command, modelPreference: primary.model ? [primary.model] : [] },
    cliKind: primary.provider,
    model: primary.model,
    fallbackTargets,
    exhaustedProviders: exhausted,
    trigger: "capacity_fallback",
    compactProfile: deps.compactProfile,
  });
}
