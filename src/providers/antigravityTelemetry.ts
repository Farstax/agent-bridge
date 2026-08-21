import type { RunTelemetry } from "../types.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function structuredResult(
  stdout: string,
  outputFormat?: "text" | "json" | "stream-json" | null,
): Record<string, unknown> | null {
  if (outputFormat === "text") return null;
  if (outputFormat === "json") {
    try { return record(JSON.parse(stdout)); } catch { return null; }
  }

  if (outputFormat === "stream-json" || stdout.trim().startsWith('{"event"')) {
    let terminal: Record<string, unknown> | null = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = record(JSON.parse(line));
        if (parsed?.event === "result") terminal = record(parsed.result);
      } catch { return null; }
    }
    return terminal;
  }
  return null;
}

/** Extract only documented, structured Agy run telemetry. Unknown fields are ignored. */
export function extractAntigravityRunTelemetry(
  stdout: string,
  outputFormat?: "text" | "json" | "stream-json" | null,
): RunTelemetry | undefined {
  const result = structuredResult(stdout, outputFormat);
  if (!result) return undefined;
  const usage = record(result.usage);
  const model = nonEmptyString(result.model);
  const inputTokens = nonNegativeNumber(usage?.input_tokens);
  const cachedInputTokens = nonNegativeNumber(usage?.cache_read_tokens);
  const outputTokens = nonNegativeNumber(usage?.output_tokens);
  const reasoningTokens = nonNegativeNumber(usage?.reasoning_tokens ?? usage?.thinking_tokens);
  const providerDurationMs = nonNegativeNumber(result.duration_ms);
  const stopReason = nonEmptyString(result.stop_reason);
  if (!model
    && inputTokens === undefined
    && cachedInputTokens === undefined
    && outputTokens === undefined
    && reasoningTokens === undefined
    && providerDurationMs === undefined
    && !stopReason) {
    return undefined;
  }
  return {
    provider: "antigravity",
    ...(model ? { model } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(providerDurationMs === undefined ? {} : { providerDurationMs }),
    ...(stopReason ? { stopReason } : {}),
  };
}
