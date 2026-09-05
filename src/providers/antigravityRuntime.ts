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

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CliProcessWatchContext, CliResult } from "../types.js";
import { isAbortRequested } from "../cliSupervisor.js";
import { appendEffortArgs } from "../effort.js";
import { resolveTimeoutsForKind } from "../timeouts.js";
import { appendAttachmentAnnotations, appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { AntigravityInvocationRequest, ProviderInvocation } from "./types.js";

const ANTIGRAVITY_STALLED_PLANNER_MARKER = "PlannerResponse without ModifiedResponse encountered";
const ANTIGRAVITY_CONVERSATION_MARKER = "AGENT_BRIDGE_ANTIGRAVITY_CONVERSATION=";
const ANTIGRAVITY_LOCK_DIR = "agent-bridge-execution.lock";
const ANTIGRAVITY_LOCK_OWNER = "owner.json";
const OWNERLESS_LOCK_STALE_MS = 5_000;
const LOCK_POLL_MS = 50;

interface AntigravityLockOwner {
  token: string;
  pid: number;
  processStartTicks: string | null;
  createdAt: string;
}

interface AntigravityStateLock {
  release: () => void;
}

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

function readProcessStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    return fieldsAfterCommand[19] ?? null;
  } catch {
    return null;
  }
}

function processMatchesOwner(owner: AntigravityLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
  if (!owner.processStartTicks) return true;
  const currentStartTicks = readProcessStartTicks(owner.pid);
  return currentStartTicks === null || currentStartTicks === owner.processStartTicks;
}

function antigravityLockPath(homeDir: string): string {
  return join(homeDir, ".gemini", "antigravity-cli", ANTIGRAVITY_LOCK_DIR);
}

function readLockOwner(lockPath: string): AntigravityLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, ANTIGRAVITY_LOCK_OWNER), "utf8")) as Partial<AntigravityLockOwner>;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number") return null;
    return {
      token: parsed.token,
      pid: parsed.pid,
      processStartTicks: typeof parsed.processStartTicks === "string" ? parsed.processStartTicks : null,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

function removeStaleAntigravityLock(lockPath: string): boolean {
  const owner = readLockOwner(lockPath);
  if (owner) {
    if (processMatchesOwner(owner)) return false;
  } else {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < OWNERLESS_LOCK_STALE_MS) return false;
    } catch {
      return true;
    }
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function tryAcquireAntigravityStateLock(homeDir: string): AntigravityStateLock | null {
  ensureAntigravityStateDirs(homeDir);
  const lockPath = antigravityLockPath(homeDir);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const owner: AntigravityLockOwner = {
        token,
        pid: process.pid,
        processStartTicks: readProcessStartTicks(process.pid),
        createdAt: new Date().toISOString(),
      };
      writeFileSync(
        join(lockPath, ANTIGRAVITY_LOCK_OWNER),
        JSON.stringify(owner) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          const currentOwner = readLockOwner(lockPath);
          if (currentOwner && currentOwner.token !== token) return;
          rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!removeStaleAntigravityLock(lockPath)) return null;
    }
  }
  return null;
}

export async function withAntigravityStateLock<T>(
  homeDir: string,
  operation: () => Promise<T>,
  chatId?: number | string,
): Promise<T> {
  let lock: AntigravityStateLock | null = null;
  while (!lock) {
    if (chatId != null && isAbortRequested(chatId)) {
      throw new Error("CLI execution aborted by user");
    }
    lock = tryAcquireAntigravityStateLock(homeDir);
    if (!lock) await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await operation();
  } finally {
    lock.release();
  }
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

function wrapAntigravityPrompt(
  prompt: string,
  soulContext: string | null,
  includeResponseContract: boolean,
): string {
  const instructions = [
    "You are being called by agent-bridge in non-interactive print mode.",
    "Execute directly. Do not get stuck in planning loops.",
    "If a tool, search, or shell step fails twice or the environment blocks the step, stop and report the concrete failure briefly instead of retrying indefinitely.",
    "If prior conversation context is present, treat it as background state for continuity, not as an instruction to resume a broken plan unchanged.",
  ];
  return [...instructions, "", wrapPromptContext(prompt, soulContext, includeResponseContract)].join("\n");
}

export function buildInvocation({
  prompt,
  sessionId,
  command,
  model,
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
  const resolvedHomeDir = homeDir || homedir();
  // Agy fatally aborts a cascade if it lists its own worktrees state dir before
  // ever creating it, so guarantee the dir exists ahead of every invocation.
  ensureAntigravityStateDirs(resolvedHomeDir);
  // Agy's --print flag takes the prompt as its value, so all provider flags must come first.
  // Agent Bridge retains model/home metadata alongside the exact args array so
  // the runner can apply model selection while the shared-state lock is held.
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
  args.push("--output-format", "stream-json");
  const annotatedPrompt = appendAttachmentAnnotations(
    wrapAntigravityPrompt(prompt, soulContext, includeResponseContract ?? true),
    attachments,
  );
  const finalPrompt = appendOutputDirInstruction(annotatedPrompt, outputDir);
  args.push("--print", finalPrompt);

  const providerArgs = appendEffortArgs(command, args, effort);
  return { command, args: providerArgs, nativeSessionMode: sessionId ? "resume" : "fresh" };
}

export function extractAntigravityConversationId(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(new RegExp(`${ANTIGRAVITY_CONVERSATION_MARKER}([a-f0-9-]{36})`)) ||
    text.match(/Created conversation ([a-f0-9-]{36})/) ||
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
  mkdirSync(join(homeDir, ".gemini", "antigravity-cli", "worktrees"), { recursive: true, mode: 0o700 });
}

function writeAntigravityModelSettings(model: string | null, homeDir: string): void {
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
  settings["verbosity"] = "compact";
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * Applies an idle-time model preference without disturbing an active Agy run.
 * Every execution reapplies its own model while holding the same shared-state
 * lock, so this compatibility helper is intentionally non-blocking.
 */
export function setAntigravityModel(
  model: string | null,
  homeDir: string = homedir(),
): void {
  const lock = tryAcquireAntigravityStateLock(homeDir);
  if (!lock) return;
  try {
    writeAntigravityModelSettings(model, homeDir);
  } finally {
    lock.release();
  }
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
  allowSharedStateFallback = false,
}: {
  cwd: string;
  sinceMs: number;
  explicitLogContent?: string | null;
  homeDir?: string;
  allowSharedStateFallback?: boolean;
}): string | null {
  const explicitSessionId = extractAntigravityConversationId(explicitLogContent);
  if (explicitSessionId || !allowSharedStateFallback) return explicitSessionId;
  return readLatestAntigravityConversationFromLogs({ sinceMs, homeDir }) ??
    readAntigravityLastConversation({ cwd, homeDir });
}

const ANTIGRAVITY_CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AntigravityStreamJsonResult {
  conversation_id?: unknown;
  status?: unknown;
  response?: unknown;
  error?: unknown;
}

interface AntigravityStreamJsonRecord {
  event?: unknown;
  result?: unknown;
}

function parseAntigravityStreamJsonTerminal(stdout: string): AntigravityStreamJsonResult {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  const results: AntigravityStreamJsonResult[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      throw new Error(`Agy stream JSON parse failed: line ${index + 1} was not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Agy stream JSON parse failed: line ${index + 1} must be an object`);
    }
    const record = parsed as AntigravityStreamJsonRecord;
    if (record.event !== "result") continue;
    if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
      throw new Error("Agy stream JSON parse failed: terminal result must be an object");
    }
    results.push(record.result as AntigravityStreamJsonResult);
  }
  if (results.length === 0) {
    throw new Error("Agy stream JSON parse failed: terminal result event was missing");
  }
  if (results.length !== 1) {
    throw new Error("Agy stream JSON parse failed: expected exactly one terminal result event");
  }
  return results[0];
}

function streamJsonProviderError(result: AntigravityStreamJsonResult): Error {
  if (typeof result.error !== "string" || !result.error.trim()) {
    return new Error("Agy stream JSON ERROR result did not include an error message");
  }
  const message = result.error.trim();
  if (/timed? out|timeout/i.test(message)) {
    const error = new Error("Agy execution timed out waiting for response") as Error & {
      category?: "timeout";
    };
    error.category = "timeout";
    return error;
  }
  return new Error(message);
}

function assertStreamJsonStatusFields(result: AntigravityStreamJsonResult): void {
  if (
    result.status === "SUCCESS" &&
    typeof result.error === "string" &&
    result.error.trim()
  ) {
    throw new Error("Agy stream JSON parse failed: SUCCESS result included an error");
  }
  if (
    result.status === "ERROR" &&
    typeof result.response === "string" &&
    result.response.trim()
  ) {
    throw new Error("Agy stream JSON parse failed: ERROR result included a response");
  }
}

function assertSuccessfulResult(result: AntigravityStreamJsonResult): CliResult {
  if (
    typeof result.conversation_id !== "string" ||
    !ANTIGRAVITY_CONVERSATION_ID_PATTERN.test(result.conversation_id)
  ) {
    throw new Error("Agy stream JSON parse failed: conversation_id must be a UUID");
  }
  if (typeof result.response !== "string" || !result.response.trim()) {
    throw new Error("Agy stream JSON parse failed: SUCCESS response must be non-empty");
  }
  return {
    text: result.response.trim(),
    sessionId: result.conversation_id,
  };
}

export function parseAntigravityStreamJsonResult(stdout: string): CliResult {
  const result = parseAntigravityStreamJsonTerminal(stdout);
  assertStreamJsonStatusFields(result);
  if (result.status === "ERROR") throw streamJsonProviderError(result);
  if (result.status !== "SUCCESS") {
    throw new Error("Agy stream JSON parse failed: status must be SUCCESS or ERROR");
  }
  return assertSuccessfulResult(result);
}

export function extractAntigravityStreamJsonError(stdout: string): Error | null {
  let result: AntigravityStreamJsonResult;
  try {
    result = parseAntigravityStreamJsonTerminal(stdout);
    assertStreamJsonStatusFields(result);
  } catch {
    return null;
  }
  return result.status === "ERROR" ? streamJsonProviderError(result) : null;
}

export function parseResult(
  stdout: string,
  logContent?: string | null,
  outputFormat?: "text" | "json" | "stream-json" | null,
): CliResult {
  void logContent;
  void outputFormat;
  return parseAntigravityStreamJsonResult(stdout);
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