/**
 * PURPOSE: Antigravity (Agy) CLI invocation building, result parsing, model
 * label mapping, state-directory bootstrap, and conversation/session
 * resolution.
 * INPUTS: A ProviderInvocationRequest (extended with logFile/homeDir), raw
 * Agy stdout/log content, model slugs, and ~/.gemini/antigravity-cli state.
 * OUTPUTS: A { command, args } invocation, a parsed CliResult, and
 * filesystem side effects for Agy's mutable settings/cache/log state.
 * NEIGHBORS: src/cli.ts (buildCliInvocation/parseCliResult dispatch),
 * src/promptWrapping.ts, src/timeouts.ts
 * LOGIC: Issue #135 Phase 3C — moved out of src/cli.ts without behavioural
 * change; locked by test/providerInvocationFixtures.test.ts (Phase 3A/3B).
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CliProcessWatchContext, CliResult } from "../types.js";
import { appendEffortArgs } from "../effort.js";
import { resolveTimeoutsForKind } from "../timeouts.js";
import { appendAttachmentAnnotations, appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { AntigravityInvocationRequest, ProviderInvocation } from "./types.js";

const ANTIGRAVITY_FINAL_RESPONSE_DELIMITER = "***";
const ANTIGRAVITY_STALLED_PLANNER_MARKER = "PlannerResponse without ModifiedResponse encountered";

function getAntigravityStalledPlannerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS || 300_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

function extractLogFileArg(args: string[]): string | null {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--log-file") return args[i + 1] || null;
  }
  return null;
}

/** Provider-owned output-failure watch; the supervisor only settles and kills. */
export function createPlannerStallWatch({ args, readStdout, onFailure }: CliProcessWatchContext): NodeJS.Timeout | null {
  const logFile = extractLogFileArg(args);
  if (!logFile) return null;
  const stallTimeoutMs = getAntigravityStalledPlannerTimeoutMs();
  const startedAt = Date.now();
  const intervalMs = Math.max(250, Math.min(stallTimeoutMs, 1_000));
  let triggered = false;

  return setInterval(() => {
    if (triggered || readStdout().trim() || Date.now() - startedAt < stallTimeoutMs) return;
    let logContent = "";
    try { logContent = readFileSync(logFile, "utf8"); } catch { return; }
    if (!logContent.includes(ANTIGRAVITY_STALLED_PLANNER_MARKER)) return;
    triggered = true;
    onFailure(new Error("Agy stalled in planner loop without usable output"), "timeout");
  }, intervalMs);
}

function wrapAntigravityPrompt(prompt: string, soulContext: string | null = null, includeResponseContract = true): string {
  return [
    "You are being called by agent-bridge in non-interactive print mode.",
    "Execute directly. Do not get stuck in planning loops.",
    "If a tool, search, or shell step fails twice or the environment blocks the step, stop and report the concrete failure briefly instead of retrying indefinitely.",
    "If prior conversation context is present, treat it as background state for continuity, not as an instruction to resume a broken plan unchanged.",
    "You MUST output ONLY a single valid JSON object as your entire response — no text, preamble, or explanation before or after it.",
    'Use this exact schema: {"response": "<the final user-facing message>"}',
    "Put everything the user should see in the 'response' field.",
    "",
    wrapPromptContext(prompt, soulContext, includeResponseContract),
  ].join("\n");
}

export function buildInvocation({
  prompt,
  sessionId,
  command,
  executionMode,
  soulContext,
  includeResponseContract,
  attachments,
  outputDir,
  effort,
  toolMode,
  logFile,
  homeDir,
}: AntigravityInvocationRequest): ProviderInvocation {
  const args: string[] = [];
  // Agy fatally aborts a cascade if it lists its own worktrees state dir before
  // ever creating it, so guarantee the dir exists ahead of every invocation.
  ensureAntigravityStateDirs(homeDir);
  // Agy's --print flag takes the prompt as its value, so all other flags must come first.
  // Agy does not expose a --model CLI flag; model selection is applied by writing to
  // ~/.gemini/antigravity-cli/settings.json before spawning (see setAntigravityModel).
  if (sessionId) args.push("--conversation", sessionId);
  if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
  if (logFile) args.push("--log-file", logFile);
  if (toolMode === "none") args.push("--sandbox");
  const timeouts = resolveTimeoutsForKind("antigravity");
  // Omit the provider flag when the bridge timeout is disabled. Passing 0s
  // is not equivalent to no timeout for Antigravity and may be interpreted as
  // an immediate provider-side expiry (Issue #177).
  if (timeouts.cliTimeoutMs > 0) {
    const timeoutSeconds = Math.floor(timeouts.cliTimeoutMs / 1000);
    args.push("--print-timeout", `${timeoutSeconds}s`);
  }
  const annotatedPrompt = appendAttachmentAnnotations(
    wrapAntigravityPrompt(prompt, soulContext, includeResponseContract),
    attachments,
  );
  const finalPrompt = appendOutputDirInstruction(annotatedPrompt, outputDir);
  args.push("--print", finalPrompt);

  return { command, args: appendEffortArgs(command, args, effort) };
}

export function extractAntigravityConversationId(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/Created conversation ([a-f0-9-]{36})/) ||
    text.match(/Print mode: conversation=([a-f0-9-]{36})/) ||
    text.match(/conversation=([a-f0-9-]{36})/);
  return match?.[1] ?? null;
}

export function toAntigravityModelLabel(model: string): string {
  const map: Record<string, string> = {
    "gemini-3.5-flash-high": "Gemini 3.5 Flash (High)",
    "gemini-3.5-flash-medium": "Gemini 3.5 Flash (Medium)",
    "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
    "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
    "claude-4.6-sonnet-thinking": "Claude Sonnet 4.6 (Thinking)",
    "claude-4.6-opus-thinking": "Claude Opus 4.6 (Thinking)",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-opus-4-8": "Claude Opus 4.8",
  };

  const normalized = model.trim().toLowerCase();
  if (map[normalized]) {
    return map[normalized];
  }

  // If the model string is already formatted as a display name (e.g. has uppercase letters and spaces/parentheses), leave it as-is
  if (/[A-Z]/.test(model) && (/\s/.test(model) || /\(/.test(model))) {
    return model;
  }

  // General fallback formatting logic for unrecognized slug patterns
  const parts = normalized.split("-");
  if (parts.length > 0) {
    const brand = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const rest = parts.slice(1);
    const words: string[] = [];
    const suffixes: string[] = [];

    for (const part of rest) {
      if (["high", "medium", "low", "thinking"].includes(part)) {
        suffixes.push(part.charAt(0).toUpperCase() + part.slice(1));
      } else if (["pro", "flash", "sonnet", "opus"].includes(part)) {
        words.push(part.charAt(0).toUpperCase() + part.slice(1));
      } else {
        words.push(part);
      }
    }

    let label = brand;
    if (words.length > 0) {
      label += " " + words.join(" ");
    }
    if (suffixes.length > 0) {
      label += " (" + suffixes.join(" ") + ")";
    }
    return label;
  }

  return model;
}

/**
 * Ensures Agy's mutable state dirs exist before a spawn. Agy's cascade engine
 * treats listing a missing directory as a fatal step error (observed with
 * ~/.gemini/antigravity-cli/worktrees), which aborts the whole run.
 */
export function ensureAntigravityStateDirs(homeDir: string = homedir()): void {
  mkdirSync(join(homeDir, ".gemini", "antigravity-cli", "worktrees"), { recursive: true });
}

/**
 * Writes the selected model into ~/.gemini/antigravity-cli/settings.json so that
 * the next Agy invocation picks it up. Pass null to remove the override and let
 * Agy fall back to its own default.
 */
export function setAntigravityModel(
  model: string | null,
  homeDir: string = homedir(),
): void {
  const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      // If the file is malformed, start fresh.
    }
  }
  if (model === null) {
    delete settings["model"];
  } else {
    settings["model"] = toAntigravityModelLabel(model);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function readAntigravityLastConversation({
  cwd,
  homeDir = homedir(),
}: {
  cwd: string;
  homeDir?: string;
}): string | null {
  const cachePath = join(homeDir, ".gemini", "antigravity-cli", "cache", "last_conversations.json");
  if (!existsSync(cachePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    const value = parsed[cwd];
    return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function readLatestAntigravityConversationFromLogs({
  sinceMs,
  homeDir = homedir(),
}: {
  sinceMs: number;
  homeDir?: string;
}): string | null {
  const logDir = join(homeDir, ".gemini", "antigravity-cli", "log");
  if (!existsSync(logDir)) return null;

  try {
    const logFiles = readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => {
        const path = join(logDir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .filter((file) => file.mtimeMs >= sinceMs - 1000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of logFiles) {
      const sessionId = extractAntigravityConversationId(readFileSync(file.path, "utf8"));
      if (sessionId) return sessionId;
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveAntigravityConversationId({
  cwd,
  sinceMs,
  explicitLogContent,
  homeDir = homedir(),
}: {
  cwd: string;
  sinceMs: number;
  explicitLogContent?: string | null;
  homeDir?: string;
}): string | null {
  return extractAntigravityConversationId(explicitLogContent) ??
    readLatestAntigravityConversationFromLogs({ sinceMs, homeDir }) ??
    readAntigravityLastConversation({ cwd, homeDir });
}

function deduplicateErrorString(text: string): string {
  const parts = text.split(":").map(p => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const uniqueParts: string[] = [];
  for (const part of parts) {
    if (!seen.has(part)) {
      seen.add(part);
      uniqueParts.push(part);
    }
  }
  return uniqueParts.join(": ");
}

function extractAntigravityError(logContent: string | null | undefined): Error | null {
  if (!logContent) return null;
  const lines = logContent.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes("agent executor error:")) {
      const idx = line.indexOf("agent executor error:");
      const rawMsg = line.substring(idx).trim();
      const cleanMsg = deduplicateErrorString(rawMsg);
      return new Error(JSON.stringify({ type: "error", message: cleanMsg }));
    }
    if (line.includes("error executing cascade step:")) {
      const idx = line.indexOf("error executing cascade step:");
      const rawMsg = line.substring(idx).trim();
      const cleanMsg = deduplicateErrorString(rawMsg);
      return new Error(JSON.stringify({ type: "error", message: cleanMsg }));
    }
    if (line.toLowerCase().includes("print mode: timed out") || line.toLowerCase().includes("timed out after")) {
      return new Error(JSON.stringify({ type: "error", message: "Print mode timed out waiting for response" }));
    }
  }
  return null;
}

function stripStatusLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^STATUS:\s+\S/i.test(line.trim()))
    .join("\n")
    .trim();
}

/**
 * Attempt to extract the `response` field from Agy's JSON output.
 * Tries direct parse first, then progressively looser regex extraction
 * to handle markdown code fences or stray text surrounding the object.
 */
function tryParseAntigravityJson(text: string): string | null {
  // 1. Direct parse
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.response === "string" && obj.response.trim()) {
      return obj.response.trim();
    }
  } catch {}

  // 2. JSON inside a markdown code block
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1]);
      if (obj && typeof obj.response === "string" && obj.response.trim()) {
        return obj.response.trim();
      }
    } catch {}
  }

  // 3. Greedy extraction: find the outermost {...} block containing "response"
  if (text.includes('"response"')) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && typeof obj.response === "string" && obj.response.trim()) {
          return obj.response.trim();
        }
      } catch {}
    }
  }

  // 4. Line-by-line reverse scan: handles output where tool-call results containing
  // "}" appear before the final JSON response, causing strategy 3 to span multiple
  // objects. Compact JSON is always on a single line; scan from the bottom up.
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"response"')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.response === "string" && obj.response.trim()) {
        return obj.response.trim();
      }
    } catch {}
  }

  return null;
}

export function parseResult(stdout: string, logContent?: string | null): CliResult {
  const logErr = extractAntigravityError(logContent);
  if (logErr) {
    throw logErr;
  }

  let text = stdout.trim();
  if (text.toLowerCase().includes("timed out waiting for response") || text.toLowerCase().includes("error: timed out")) {
    throw new Error(JSON.stringify({ type: "error", message: "Agy execution timed out waiting for response" }));
  }

  const sessionId = extractAntigravityConversationId(logContent);

  // Primary: JSON output approach — extract the `response` field
  const jsonResponse = tryParseAntigravityJson(text);
  if (jsonResponse) {
    return { text: jsonResponse, sessionId };
  }

  // Legacy fallback: *** delimiter
  const markerIndex = text.indexOf(ANTIGRAVITY_FINAL_RESPONSE_DELIMITER);
  if (markerIndex !== -1) {
    const lines = text.split(/\r?\n/);
    let separatorIdx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const trimmed = lines[i].trim();
      // Match lines that ARE "***" or that END with "***" (e.g. "STATUS: done***")
      if (trimmed === ANTIGRAVITY_FINAL_RESPONSE_DELIMITER || trimmed.endsWith(ANTIGRAVITY_FINAL_RESPONSE_DELIMITER)) {
        separatorIdx = i;
        break;
      }
    }
    if (separatorIdx !== -1) {
      text = stripStatusLines(lines.slice(separatorIdx + 1).join("\n").trim());
      if (!text) {
        throw new Error(JSON.stringify({ type: "error", message: "Agy execution returned empty response" }));
      }
      return { text, sessionId };
    }
  }

  // Legacy fallback: Split on the "🧠 Memory Loaded:" boot signature
  const memoryMarker = "🧠 Memory Loaded:";
  const memoryIndex = text.indexOf(memoryMarker);
  if (memoryIndex !== -1) {
    const lineEndIndex = text.indexOf("\n", memoryIndex);
    if (lineEndIndex !== -1) {
      text = text.substring(lineEndIndex + 1).trim();
    }
  }

  text = stripStatusLines(text);

  if (!text) {
    throw new Error(JSON.stringify({ type: "error", message: "Agy JSON parse failed: could not extract response field from output" }));
  }

  return { text, sessionId };
}

export function isPreExecutionDnsFailure(
  bot: string | undefined,
  args: string[],
  stdout: string,
  stderr: string
): boolean {
  if (bot !== "antigravity") return false;

  // 0. Proactively reject if there is any stdout at all (which implies output was produced)
  if (stdout.trim() !== "") return false;

  // 1. Match exact Agy eligibility/loadCodeAssist failure class
  const hasEligibilityFailure =
    stderr.includes("Error: Eligibility check failed") &&
    stderr.includes("daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") &&
    (stderr.includes("i/o timeout") || stderr.includes("temporary failure") || stderr.includes("lookup"));

  if (!hasEligibilityFailure) return false;

  // 2. Reject retry after any execution/cascade markers (proven pre-execution only)
  const hasExecutionMarkers =
    stdout.includes("🧠 Memory Loaded:") ||
    stdout.includes("Print mode: conversation=") ||
    stdout.includes("Created conversation") ||
    stderr.includes("🧠 Memory Loaded:") ||
    stderr.includes("Print mode: conversation=") ||
    stderr.includes("Created conversation");

  if (hasExecutionMarkers) return false;

  // 3. Limit retry to tool-free/read-only (sandboxed) runs
  const isSandboxed = args.includes("--sandbox");
  if (!isSandboxed) return false;

  return true;
}
