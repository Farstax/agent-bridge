/**
 * PURPOSE: Fetches and formats Codex ChatGPT plan usage for Telegram-safe reporting.
 * INPUTS: Codex OAuth auth.json contents, ChatGPT Codex usage endpoint responses, and timezone identifiers.
 * OUTPUTS: Redacted usage summaries with plan type, usage percentages, reset times, and limit state.
 * NEIGHBORS: src/index.ts, src/commands.ts
 * LOGIC: Reads only the OAuth access token, calls the fixed Codex usage endpoint, validates response shape lightly, and never exposes identity fields or tokens.
 */

import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const codexUsageUrl = "https://chatgpt.com/backend-api/codex/usage";

type UsageFetchInit = {
  method: "GET";
  headers: Record<string, string>;
};

type UsageFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  body?: { cancel: () => Promise<void> } | null;
};

type FetchLike = (input: string, init?: UsageFetchInit) => Promise<UsageFetchResponse>;

type UsageWindow = {
  used_percent?: unknown;
  reset_at?: unknown;
};

type CodexUsageResponse = {
  plan_type?: unknown;
  rate_limit?: {
    allowed?: unknown;
    limit_reached?: unknown;
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  } | null;
};

const MAX_CAPACITY_RESET_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Turns the existing read-only usage payload into bounded retry evidence.
 * Only a provider-confirmed exhausted account may influence retry timing.
 */
export function selectCodexCapacityResetAt(usage: CodexUsageResponse, nowMs = Date.now()): string | null {
  const rateLimit = usage.rate_limit;
  if (!rateLimit || (rateLimit.limit_reached !== true && rateLimit.allowed !== false)) return null;
  const nowSeconds = Math.floor(nowMs / 1_000);
  const candidates = [rateLimit.primary_window?.reset_at, rateLimit.secondary_window?.reset_at]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .filter((value) => value > nowSeconds && value - nowSeconds <= MAX_CAPACITY_RESET_WINDOW_SECONDS);
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates) * 1_000).toISOString();
}

export function defaultCodexAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

export function readCodexAccessToken(authPath = defaultCodexAuthPath()): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Codex auth file at ${authPath}`);
  }

  if (!isRecord(parsed) || parsed.auth_mode !== "chatgpt") {
    throw new Error("Codex ChatGPT OAuth auth is not configured.");
  }

  const tokens = parsed.tokens;
  if (!isRecord(tokens) || typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("Codex OAuth access token is missing.");
  }

  return tokens.access_token;
}

export async function fetchCodexUsage(accessToken: string, fetchImpl?: FetchLike): Promise<CodexUsageResponse> {
  const body = fetchImpl
    ? await fetchCodexUsageWithFetch(accessToken, fetchImpl)
    : await fetchCodexUsageWithHttps(accessToken);

  if (!isRecord(body)) {
    throw new Error("Codex usage response was not a JSON object.");
  }

  return body as CodexUsageResponse;
}

/** Read-only best-effort capacity evidence for the active Codex account. */
export async function fetchCodexCapacityResetAt(authPath = defaultCodexAuthPath()): Promise<string | null> {
  return selectCodexCapacityResetAt(await fetchCodexUsage(readCodexAccessToken(authPath)));
}

async function fetchCodexUsageWithFetch(accessToken: string, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(codexUsageUrl, {
    method: "GET",
    headers: usageHeaders(accessToken),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Codex usage request failed with HTTP ${response.status}.`);
  }

  return response.json();
}

async function fetchCodexUsageWithHttps(accessToken: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(codexUsageUrl, {
      method: "GET",
      headers: usageHeaders(accessToken),
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Codex usage request failed with HTTP ${statusCode}.`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Codex usage response was not valid JSON."));
        }
      });
    });

    request.setTimeout(15_000, () => {
      request.destroy(new Error("Codex usage request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

function usageHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "agent-bridge-codex-usage",
  };
}

export async function getCodexUsageText(authPath = defaultCodexAuthPath(), timeZone = localTimeZone()): Promise<string> {
  const accessToken = readCodexAccessToken(authPath);
  const usage = await fetchCodexUsage(accessToken);
  return formatCodexUsage(usage, timeZone);
}

export function formatCodexUsage(usage: CodexUsageResponse, timeZone = localTimeZone()): string {
  const rateLimit = usage.rate_limit;
  const primary = rateLimit?.primary_window ?? null;
  const secondary = rateLimit?.secondary_window ?? null;

  return [
    "Codex usage",
    "",
    `Plan: ${formatValue(usage.plan_type)}`,
    `Primary: ${formatPercent(primary?.used_percent)} used, resets ${formatReset(primary?.reset_at, timeZone)}`,
    `Secondary: ${formatPercent(secondary?.used_percent)} used, resets ${formatReset(secondary?.reset_at, timeZone)}`,
    `Allowed: ${formatBoolean(rateLimit?.allowed)}`,
    `Limit reached: ${formatBoolean(rateLimit?.limit_reached)}`,
  ].join("\n");
}

function formatValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function formatPercent(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "unknown";
}

function formatBoolean(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return "unknown";
}

function formatReset(value: unknown, timeZone: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value * 1000));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}`;
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
