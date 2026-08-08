/**
 * PURPOSE: Shared compaction service — the single path for summarising a chat's
 * conversation, promoting durable memory candidates, and pruning covered turns.
 * Used by /compact; a later PR wires the same service into fallback/switch handoff.
 * Compaction failure is non-destructive: no summary is stored and no turns are
 * pruned unless summarisation succeeds and produces valid structured output.
 * NEIGHBORS: src/engine.ts, src/compactSummary.ts, src/projectMemory.ts, src/db.ts
 */

import type { BridgeDb } from "./db.js";
import { buildCliInvocation, buildExecutionOptions, parseCliResult } from "./cli.js";
import { setAntigravityModel } from "./providers/antigravityRuntime.js";
import { resolveEffort } from "./effort.js";
import type { BotKind, CliOptions } from "./types.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  buildCompactSummaryPrompt,
  buildCompactReducePrompt,
  buildCompactRepairPrompt,
  chunkCompactTurns,
  compactParallelism,
  parseCompactOutput,
  COMPACT_TIMEOUT_MS,
  type CompactProfile,
} from "./compactSummary.js";
import { storeProjectMemoryCandidate } from "./projectMemory.js";
import type { CompactionErrorCategory } from "./repositories/compactionRepository.js";
import { classifyProviderError } from "./providers/errorClassification.js";
import { supportsToolFreeMode } from "./providers/registry.js";

const DEFAULT_COMPACTION_MAX_ATTEMPTS = 3;
const MAX_COMPACTION_MAX_ATTEMPTS = 8;
const DEFAULT_COMPACTION_REPAIR_ATTEMPTS = 1;
const COMPANION_MEMORY_SCOPE_GUIDANCE = [
  "Companion memory scope policy:",
  "Use project scope only for durable project knowledge that should remain available across Agent Bridge chats: architecture/design decisions, product requirements or owner decisions, durable implementation or operational conventions, and named project facts that will matter later.",
  "Use chat scope for temporary task/progress detail, conversation-specific context, participant context, and personal/social context that is only relevant to this conversation.",
  "Use global only for facts deliberately intended to be broader than this project.",
  "When scope is uncertain, use chat.",
].join("\n");

function boundedEnvInt(name: string, fallback: number, maximum: number, allowZero = false): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < (allowZero ? 0 : 1)) return fallback;
  return Math.min(maximum, parsed);
}

export function compactMaxAttempts(): number {
  return boundedEnvInt("BRIDGE_COMPACTION_MAX_ATTEMPTS", DEFAULT_COMPACTION_MAX_ATTEMPTS, MAX_COMPACTION_MAX_ATTEMPTS);
}

export function compactRepairAttempts(): number {
  return boundedEnvInt("BRIDGE_COMPACTION_REPAIR_ATTEMPTS", DEFAULT_COMPACTION_REPAIR_ATTEMPTS, 1, true);
}

export interface CompactionFallbackTarget {
  provider: BotKind;
  command: string;
  model: string | null;
}

export interface CompactConversationDeps {
  db: BridgeDb;
  runCli: (command: string, args: string[], cwd: string, options: CliOptions) => Promise<string>;
  botConfig: { command: string; modelPreference: string[] };
  cliKind: string;
  trigger: CompactionTrigger;
  compactProfile?: CompactProfile;
  now?: () => Date;
  model?: string | null;
  fallbackTargets?: readonly CompactionFallbackTarget[];
  exhaustedProviders?: readonly BotKind[];
  maxAttempts?: number;
  repairAttempts?: number;
  /** Optional execution-lane fence, evaluated inside the persistence transaction. */
  assertCanCommit?: () => void;
}

export type CompactConversationOutcome = "compacted" | "no_turns" | "failed";
export type CompactionTrigger = "manual" | "preseed" | "capacity_fallback";

export interface CompactConversationResult {
  outcome: CompactConversationOutcome;
  trigger: CompactionTrigger;
  summaryMd?: string;
  turnCount?: number;
  startId?: number;
  endId?: number;
  promotedMemoryIds?: string[];
  rejectedCandidateCount?: number;
  error?: string;
}

function companionScopedCandidate(
  candidate: Record<string, unknown>,
  compactProfile: CompactProfile,
): Record<string, unknown> {
  if (compactProfile !== "companion") return candidate;
  if (candidate.scope === "project" || candidate.scope === "chat" || candidate.scope === "global") return candidate;
  return { ...candidate, scope: "chat" };
}

export async function compactConversation(
  chatKey: string,
  deps: CompactConversationDeps,
): Promise<CompactConversationResult> {
  const { db, runCli, botConfig, cliKind, trigger, compactProfile = "engineering", now = () => new Date() } = deps;
  const startedAt = now();
  const initialModel = deps.model !== undefined
    ? deps.model
    : db.getSetting(cliKind) || botConfig.modelPreference[0] || null;
  let finalProvider = cliKind;
  let finalModel = initialModel;
  let cliCallCount = 0;
  let chunkCount = 0;
  let rangeStartTurnId: number | null = null;
  let rangeEndTurnId: number | null = null;

  const finish = (
    result: CompactConversationResult,
    errorCategory: CompactionErrorCategory | null = null,
  ): CompactConversationResult => {
    const endedAt = now();
    try {
      db.addCompactionAttempt({
        chatKey,
        trigger,
        provider: finalProvider,
        model: finalModel,
        outcome: result.outcome,
        errorCategory,
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        chunkCount,
        cliCallCount,
        rangeStartTurnId,
        rangeEndTurnId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
    } catch {
      console.warn(`[compaction-telemetry] write failed for ${trigger}/${result.outcome}`);
    }
    return result;
  };

  const previousSummary = db.getLatestConvSummary(chatKey);
  const turns = db.getConvTurnsForCompaction(chatKey);
  if (turns.length === 0) return finish({ outcome: "no_turns", trigger });

  const startId = turns[0].id;
  const endId = turns[turns.length - 1].id;
  const chunks = chunkCompactTurns(turns);
  chunkCount = chunks.length;
  rangeStartTurnId = startId;
  rangeEndTurnId = endId;

  const exhausted = new Set(deps.exhaustedProviders ?? []);
  const targets: CompactionFallbackTarget[] = [];
  const seenTargets = new Set<string>();
  const addTarget = (target: CompactionFallbackTarget, initial = false): void => {
    if (exhausted.has(target.provider)) return;
    if (!initial && !supportsToolFreeMode(target.provider)) return;
    const key = `${target.provider}:${target.model ?? ""}`;
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    targets.push(target);
  };
  addTarget({
    provider: cliKind as BotKind,
    command: botConfig.command,
    model: initialModel,
  }, true);
  for (const target of deps.fallbackTargets ?? []) addTarget(target);
  const maxAttempts = Math.min(MAX_COMPACTION_MAX_ATTEMPTS, Math.max(1, deps.maxAttempts ?? compactMaxAttempts()));
  const repairAttempts = Math.min(1, Math.max(0, deps.repairAttempts ?? compactRepairAttempts()));
  const boundedTargets = targets.slice(0, maxAttempts);

  const callTarget = async (target: CompactionFallbackTarget, prompt: string): Promise<string> => {
    if (target.provider === "kimchi") {
      throw new CompactionFailure(
        "fatal",
        false,
        "Kimchi compaction is disabled because verified tool-free execution is not supported",
      );
    }
    if (!target.command.trim()) {
      throw new CompactionFailure("provider_unavailable", true);
    }
    if (target.provider === "antigravity") setAntigravityModel(target.model);
    const scopedPrompt = compactProfile === "companion"
      ? `${COMPANION_MEMORY_SCOPE_GUIDANCE}\n\n${prompt}`
      : prompt;
    const invocation = buildCliInvocation({
      bot: target.provider,
      prompt: scopedPrompt,
      sessionId: null,
      command: target.command,
      model: target.model,
      effort: resolveEffort(target.provider, db),
      executionMode: "safe",
      outputFormat: target.provider === "codex" || target.provider === "claude" ? "json" : null,
      toolMode: "none",
    });
    cliCallCount++;
    let timeout: NodeJS.Timeout | null = null;
    let cancelTimeout = (): void => {};
    let raw: string;
    try {
      raw = await Promise.race([
        runCli(invocation.command, invocation.args, process.cwd(), buildExecutionOptions(target.provider)),
        new Promise<string>((resolve, reject) => {
          cancelTimeout = () => resolve("");
          timeout = setTimeout(() => reject(new Error("compact timeout")), COMPACT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      cancelTimeout();
    }
    return typeof raw === "string" ? raw.trim() : "";
  };

  const summarizeToOutput = async (prompt: string) => {
    let lastFailure = new CompactionFailure("provider_unavailable", true);
    let repairsRemaining = repairAttempts;
    for (const target of boundedTargets) {
      finalProvider = target.provider;
      finalModel = target.model;
      try {
        const raw = await callTarget(target, prompt);
        const invalidResponse = parseCompactionProviderResponse(target.provider, raw);
        const parsed = parseCompactOutput(invalidResponse);
        if (parsed) return parsed;

        if (repairsRemaining > 0) {
          repairsRemaining--;
          const repairedRaw = await callTarget(
            target,
            buildCompactRepairPrompt(invalidResponse, compactProfile),
          );
          const repairedResponse = parseCompactionProviderResponse(target.provider, repairedRaw);
          const repaired = parseCompactOutput(repairedResponse);
          if (repaired) return repaired;
        }
        lastFailure = new CompactionFailure("invalid_output", true);
      } catch (error) {
        lastFailure = toCompactionFailure(target.provider, error);
      }
      if (!lastFailure.fallbackEligible) throw lastFailure;
    }
    throw lastFailure;
  };

  let finalOutput: { summaryMd: string; memoryCandidates: Array<Record<string, unknown>> };
  try {
    if (chunks.length === 1 && !previousSummary) {
      finalOutput = await summarizeToOutput(buildCompactSummaryPrompt(turns, compactProfile));
    } else {
      const parallelism = compactParallelism();
      const chunkSummaries = await mapWithConcurrency(chunks, parallelism, async (chunk) => {
        const parsed = await summarizeToOutput(buildCompactSummaryPrompt(chunk, compactProfile));
        return {
          startId: chunk[0].id!,
          endId: chunk[chunk.length - 1].id!,
          summary: parsed.summaryMd,
        };
      });
      finalOutput = await summarizeToOutput(
        buildCompactReducePrompt(previousSummary?.summary_md ?? null, chunkSummaries, compactProfile),
      );
    }
  } catch (error) {
    // Non-destructive: no summary stored, no turns pruned. Previous summary and
    // raw turns remain available so the conversation can continue.
    const failure = error instanceof CompactionFailure
      ? error
      : toCompactionFailure(finalProvider as BotKind, error);
    return finish({
      outcome: "failed",
      trigger,
      error: failure.safeMessage,
      turnCount: turns.length,
      startId,
      endId,
    }, failure.category);
  }

  const promotedMemoryIds: string[] = [];
  let rejectedCandidateCount = 0;
  try {
    db.runInTransaction(() => {
      deps.assertCanCommit?.();
      db.addConvSummary(chatKey, startId, endId, finalOutput.summaryMd);

      for (const rawCandidate of finalOutput.memoryCandidates) {
        const candidate = companionScopedCandidate(rawCandidate, compactProfile);
        const result = storeProjectMemoryCandidate(db, candidate, {
          chatKey,
          cliKind: finalProvider,
          repoPath: process.cwd(),
        });
        if (result.status === "stored") promotedMemoryIds.push(result.id);
        else if (result.status === "rejected") rejectedCandidateCount++;
      }

      db.pruneConvTurns(chatKey, endId);
    });
  } catch {
    return finish({
      outcome: "failed",
      trigger,
      error: "Compaction failed (unknown)",
      turnCount: turns.length,
      startId,
      endId,
    }, "unknown");
  }

  return finish({
    outcome: "compacted",
    trigger,
    summaryMd: finalOutput.summaryMd,
    turnCount: turns.length,
    startId,
    endId,
    promotedMemoryIds,
    rejectedCandidateCount,
  });
}

function parseCompactionProviderResponse(provider: BotKind, raw: string): string {
  try {
    return parseCliResult({ bot: provider, stdout: raw }).text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (provider === "antigravity" &&
        /Agy JSON parse failed: could not extract response field|Agy execution returned empty response/i.test(message)) {
      return "";
    }
    throw error;
  }
}

class CompactionFailure extends Error {
  constructor(
    readonly category: CompactionErrorCategory,
    readonly fallbackEligible: boolean,
    readonly safeMessage = `Compaction failed (${category})`,
  ) {
    super(safeMessage);
  }
}

function toCompactionFailure(provider: BotKind, error: unknown): CompactionFailure {
  if (error instanceof CompactionFailure) return error;
  const value = error instanceof Error ? error : new Error(String(error));
  if (value.name === "AbortError" || /cancelled by user|canceled by user|aborted by user/i.test(value.message)) {
    return new CompactionFailure("cancelled", false);
  }
  if (/timeout|timed out/i.test(value.message)) return new CompactionFailure("timeout", true);

  const providerId = provider === "antigravity" ? "agy" : provider;
  const classification = classifyProviderError(providerId, value);
  switch (classification.kind) {
    case "auth_required": return new CompactionFailure("auth", true);
    case "capacity_exhausted": return new CompactionFailure("capacity", true);
    case "model_unavailable": return new CompactionFailure("provider_unavailable", true);
    case "transient": return new CompactionFailure("transient", true);
    case "fatal": return new CompactionFailure("fatal", false);
    default: return new CompactionFailure("fatal", false);
  }
}
