import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { CliResult, RunTelemetry } from "./types.js";
import { captureParsedProviderOutput } from "./runTelemetry.js";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function encodeFileAsBase64(filePath: string): Promise<{ data: string; mimeType: string }> {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
  const data = readFileSync(filePath).toString("base64");
  return { data, mimeType };
}

export function buildClaudeStreamJsonInput(prompt: string, attachments: string[]): string {
  if (!attachments.length) {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    });
  }

  const content: any[] = [];
  for (const filePath of attachments) {
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
    const data = readFileSync(filePath).toString("base64");
    content.push({
      type: "image",
      source: { type: "base64", media_type: mimeType, data },
    });
  }
  content.push({ type: "text", text: prompt });

  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
  });
}

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

const CLAUDE_SERVER_TOOL_COUNTERS = new Set([
  "web_search_requests",
  "web_fetch_requests",
]);

function knownServerToolCounters(value: unknown): Record<string, number> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const counters = Object.fromEntries([...CLAUDE_SERVER_TOOL_COUNTERS].flatMap((key) => {
    const count = nonNegativeNumber(source[key]);
    return count === undefined ? [] : [[key, count]];
  }));
  return Object.keys(counters).length ? counters : undefined;
}

export function parseClaudeResultObject(value: unknown): CliResult | null {
  const obj = record(value);
  if (!obj || obj.type !== "result" || typeof obj.result !== "string") return null;
  const usage = record(obj.usage);
  const modelUsage = record(obj.modelUsage);
  const modelKeys = modelUsage ? Object.keys(modelUsage).filter((key) => key.trim()) : [];
  const inputTokens = nonNegativeNumber(usage?.input_tokens);
  const cachedInputTokens = nonNegativeNumber(usage?.cache_read_input_tokens);
  const cacheCreationInputTokens = nonNegativeNumber(usage?.cache_creation_input_tokens);
  const outputTokens = nonNegativeNumber(usage?.output_tokens);
  const costUsd = nonNegativeNumber(obj.total_cost_usd);
  const providerDurationMs = nonNegativeNumber(obj.duration_ms);
  const providerApiDurationMs = nonNegativeNumber(obj.duration_api_ms);
  const turns = nonNegativeNumber(obj.num_turns);
  const stopReason = nonEmptyString(obj.stop_reason);
  const terminalReason = nonEmptyString(obj.terminal_reason);
  const serviceTier = nonEmptyString(usage?.service_tier);
  const toolUseCounts = knownServerToolCounters(usage?.server_tool_use);
  const hasTelemetry = modelKeys.length === 1
    || inputTokens !== undefined
    || cachedInputTokens !== undefined
    || cacheCreationInputTokens !== undefined
    || outputTokens !== undefined
    || costUsd !== undefined
    || providerDurationMs !== undefined
    || providerApiDurationMs !== undefined
    || turns !== undefined
    || !!stopReason
    || !!terminalReason
    || !!serviceTier
    || !!toolUseCounts;
  const telemetry: RunTelemetry | undefined = hasTelemetry ? {
    provider: "claude",
    ...(modelKeys.length === 1 ? { model: modelKeys[0] } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(providerDurationMs === undefined ? {} : { providerDurationMs }),
    ...(providerApiDurationMs === undefined ? {} : { providerApiDurationMs }),
    ...(turns === undefined ? {} : { turns }),
    ...(stopReason ? { stopReason } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(toolUseCounts ? { toolUseCounts } : {}),
  } : undefined;
  return {
    text: obj.result.trim(),
    sessionId: typeof obj.session_id === "string" ? obj.session_id : null,
    ...(telemetry ? { telemetry } : {}),
  };
}

export function parseClaudeStreamJsonOutput(stdout: string): CliResult | null {
  let last: CliResult | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      last = parseClaudeResultObject(JSON.parse(trimmed)) ?? last;
    } catch { /* skip non-JSON */ }
  }
  if (last) captureParsedProviderOutput("claude", stdout, last.telemetry);
  return last;
}
