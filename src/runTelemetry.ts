import { createHash } from "node:crypto";
import type { BotKind, RunTelemetry, RunTelemetryFallback } from "./types.js";

interface RunAttemptState {
  firstProvider: BotKind;
  lastProvider: BotKind;
  firstModel: string | null;
  lastModel: string | null;
  attempts: number;
  startedAtMs: number;
}
interface OutputCorrelation { runId: string; provider: BotKind }

const MAX_TRANSIENT_RUNS = 1024;
const attemptsByRun = new Map<string, RunAttemptState>();
const fallbackByRun = new Map<string, RunTelemetryFallback>();
const fallbackChainByChat = new Map<string, RunTelemetryFallback>();
const chatByRun = new Map<string, string>();
const parsedByRun = new Map<string, RunTelemetry>();
const outputCorrelations = new Map<string, OutputCorrelation[]>();

function trimOldest<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_TRANSIENT_RUNS) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
function outputKey(provider: BotKind, stdout: string): string {
  return `${provider}:${createHash("sha256").update(stdout).digest("hex")}`;
}

export function noteRunProviderAttempt(runId: string | undefined, provider: BotKind | undefined, model: string | null, nowMs = Date.now()): void {
  if (!runId || !provider) return;
  const current = attemptsByRun.get(runId);
  if (!current) {
    attemptsByRun.set(runId, { firstProvider: provider, lastProvider: provider, firstModel: model, lastModel: model, attempts: 1, startedAtMs: nowMs });
    trimOldest(attemptsByRun);
    return;
  }
  current.lastProvider = provider;
  current.lastModel = model;
  current.attempts += 1;
}

export function noteRunFallback(runId: string | undefined, fallback: RunTelemetryFallback | undefined): void {
  if (!runId || !fallback) return;
  fallbackByRun.set(runId, { ...fallback });
  trimOldest(fallbackByRun);
}

export function notePendingRunFallback(chatKey: string, fallback: RunTelemetryFallback | null): void {
  if (!fallback) {
    fallbackChainByChat.delete(chatKey);
    return;
  }
  const prior = fallbackChainByChat.get(chatKey);
  fallbackChainByChat.set(chatKey, prior ? {
    fromProvider: prior.fromProvider,
    toProvider: fallback.toProvider,
    fromModel: prior.fromModel,
    toModel: fallback.toModel,
    attempt: prior.attempt + 1,
  } : { ...fallback });
  trimOldest(fallbackChainByChat);
}

export function consumePendingRunFallback(
  runId: string | undefined,
  chatKey: string | undefined,
  provider: BotKind | undefined,
): void {
  if (!runId || !chatKey || !provider) return;
  const fallback = fallbackChainByChat.get(chatKey);
  if (!fallback) return;
  if (fallback.toProvider !== provider) {
    // A reset/new admission returned to another provider before the fallback
    // Run started. Discard the stale provenance rather than contaminating a
    // later unrelated Run.
    fallbackChainByChat.delete(chatKey);
    return;
  }
  noteRunFallback(runId, fallback);
  chatByRun.set(runId, chatKey);
  trimOldest(chatByRun);
}

export function registerProviderOutput(runId: string | undefined, provider: BotKind | undefined, stdout: string): void {
  if (!runId || !provider) return;
  const key = outputKey(provider, stdout);
  const queue = outputCorrelations.get(key) ?? [];
  queue.push({ runId, provider });
  outputCorrelations.set(key, queue);
  trimOldest(outputCorrelations);
}

export function captureParsedProviderOutput(provider: BotKind, stdout: string, telemetry: RunTelemetry | undefined): void {
  const key = outputKey(provider, stdout);
  const queue = outputCorrelations.get(key);
  if (!queue?.length) return;
  const correlation = queue.shift()!;
  if (queue.length === 0) outputCorrelations.delete(key);
  if (!telemetry) return;
  parsedByRun.set(correlation.runId, telemetry);
  trimOldest(parsedByRun);
}

export function finalizeRunTelemetry(runId: string | undefined, provider: BotKind, parsed?: RunTelemetry, nowMs = Date.now()): RunTelemetry {
  const state = runId ? attemptsByRun.get(runId) : undefined;
  const inheritedFallback = runId ? fallbackByRun.get(runId) : undefined;
  const parsedTelemetry = parsed ?? (runId ? parsedByRun.get(runId) : undefined);
  const finalProvider = parsedTelemetry?.provider ?? state?.lastProvider ?? provider;
  const finalModel = parsedTelemetry?.model ?? state?.lastModel ?? null;
  const localRetries = state ? Math.max(0, state.attempts - 1) : 0;
  const retryCount = Math.max(localRetries, inheritedFallback?.attempt ?? 0);
  const changedTarget = !!state && (state.firstProvider !== state.lastProvider || state.firstModel !== state.lastModel);
  const derivedFallback: RunTelemetryFallback | undefined = changedTarget ? {
    fromProvider: state!.firstProvider,
    toProvider: finalProvider,
    fromModel: state!.firstModel,
    toModel: finalModel,
    attempt: retryCount,
  } : undefined;
  const fallback = inheritedFallback ? {
    ...inheritedFallback,
    toProvider: finalProvider,
    toModel: finalModel,
    attempt: retryCount,
  } : derivedFallback;
  const result: RunTelemetry = {
    ...(parsedTelemetry ?? { provider: finalProvider }),
    provider: finalProvider,
    ...(finalModel ? { model: finalModel } : {}),
    ...(state ? { durationMs: Math.max(0, nowMs - state.startedAtMs) } : {}),
    ...(retryCount > 0 ? { retryCount } : {}),
    ...(fallback ? { fallback } : {}),
  };
  if (runId) {
    const chatKey = chatByRun.get(runId);
    clearRunTelemetry(runId);
    if (chatKey) fallbackChainByChat.delete(chatKey);
  }
  return result;
}

export function clearRunTelemetry(runId: string | undefined): void {
  if (!runId) return;
  attemptsByRun.delete(runId);
  fallbackByRun.delete(runId);
  parsedByRun.delete(runId);
  chatByRun.delete(runId);
  for (const [key, queue] of outputCorrelations) {
    const remaining = queue.filter((item) => item.runId !== runId);
    if (remaining.length === 0) outputCorrelations.delete(key);
    else if (remaining.length !== queue.length) outputCorrelations.set(key, remaining);
  }
}
