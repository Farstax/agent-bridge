#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import Database from "better-sqlite3";
import { killChildTree, killChildTreeWaitBoundMs, readProcessStartTicks } from "./cliSupervisor.js";
import { commandExistsOnPath, resolveInteractiveCliAuthPaths } from "./interactiveCliAuth.js";
import { resolveProviderRuntime } from "./providers/acpRuntime.js";
import { isProviderApiKeyConfigured } from "./providers/apiKeyAuth.js";
import { getProviderRuntimeAuthDegradedProviders } from "./providers/runtimeAvailability.js";

export type ReviewProvider = "claude" | "codex" | "antigravity" | "grok" | "cursor";

export interface ReviewInvocationOptions {
  provider: ReviewProvider;
  implementer: string;
  base: Record<string, string | undefined>;
  releaseDir: string;
}

const RUN_SCOPED_AGENT_BRIDGE_ENV = /^AGENT_BRIDGE_(?:RUN_ID|SERVICE_ID|ACQUISITION_ID|LOCK_|OUTCOME_COMMAND|WAIT_COMMAND|SCRATCH_COMMAND|CHAT_KEY|SURFACE_IDENTITY|OWNER_KEY|CONTEXT_(?:DB|AVAILABLE|COMMAND)|DELIVERY_)/;


export interface ProcessRecord {
  ppid: number;
  startTicks: string | null;
  environ: Record<string, string>;
}

function readProcRecord(pid: number): ProcessRecord | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const environ: Record<string, string> = {};
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const split = entry.indexOf("=");
      if (split > 0) environ[entry.slice(0, split)] = entry.slice(split + 1);
    }
    return Number.isInteger(ppid) ? { ppid, startTicks: readProcessStartTicks(pid), environ } : null;
  } catch {
    return null;
  }
}

export interface RecordedRunStart {
  bot: string;
  process?: { pid: number; startTicks: string };
}

function readRecordedRunStarts(dbPath: string, runId: string): RecordedRunStart[] {
  const db = openReadOnlyReviewDatabase(dbPath);
  try {
    return (db.prepare("SELECT payload_json FROM bridge_events WHERE run_id = ? ORDER BY seq ASC").all(runId) as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json) as RecordedRunStart & { type?: string })
      .filter((event) => event.type === "run.started");
  } finally {
    db.close();
  }
}

/**
 * The implementer is the Run whose recorded run.started process (PID plus
 * kernel start time) is a live ancestor of this helper. Environment markers
 * only locate candidate Runs; a relabelled or orphaned process is not the
 * process Bridge recorded, so the review fails closed.
 */
export function resolveImplementingRun(
  startPid: number = process.pid,
  readProcess: (pid: number) => ProcessRecord | null = readProcRecord,
  readRunStarts: (dbPath: string, runId: string) => RecordedRunStart[] = readRecordedRunStarts,
): { runId: string; dbPath: string; bot: string } {
  const ancestry: Array<ProcessRecord & { pid: number }> = [];
  const seen = new Set<number>();
  for (let pid = startPid; pid > 1 && !seen.has(pid);) {
    seen.add(pid);
    const record = readProcess(pid);
    if (!record) break;
    ancestry.push({ pid, ...record });
    pid = record.ppid;
  }
  for (const candidate of ancestry.reverse()) {
    const runId = candidate.environ.AGENT_BRIDGE_RUN_ID?.trim();
    const dbPath = candidate.environ.DB_PATH?.trim();
    if (!runId || !dbPath || !candidate.startTicks) continue;
    let starts: RecordedRunStart[];
    try {
      starts = readRunStarts(dbPath, runId);
    } catch {
      continue;
    }
    const bound = starts.find((start) => start.process?.pid === candidate.pid && start.process.startTicks === candidate.startTicks);
    if (bound) return { runId, dbPath, bot: bound.bot };
  }
  throw new Error("implementing Bridge Run cannot be established from a Bridge-recorded ancestor process");
}

export function readImplementingProvider(db: Database.Database, runId: string, recordedBot: string): string {
  const run = db.prepare("SELECT bot, status FROM bridge_runs WHERE run_id = ?").get(runId) as { bot?: string; status?: string } | undefined;
  if (!run?.bot) throw new Error("implementing Bridge Run is not recorded");
  if (run.status !== "running") throw new Error(`implementing Bridge Run is not active (${run.status ?? "unknown"})`);
  if (run.bot !== recordedBot) throw new Error("implementing Bridge Run provider is inconsistent");
  return run.bot;
}

export function buildAcpReviewEnvironment(options: ReviewInvocationOptions): NodeJS.ProcessEnv {
  if (!options.base.DB_PATH?.trim()) throw new Error("DB_PATH is required for durable Bridge review evidence");
  const env: NodeJS.ProcessEnv = {
    ...options.base,
    AGENT_BRIDGE_PROVIDER: options.implementer,
    BRIDGE_PROVIDER_LOCK: options.provider,
    INTERACTIVE_CLI_CHAIN: options.provider,
    BRIDGE_EXECUTION_MODE: "safe",
    // Runtime context injected by Bridge must resolve to trusted release-owned
    // helpers. The ACP session itself still opens the candidate at its cwd.
    BRIDGE_PROJECT_DIR: options.releaseDir,
    BRIDGE_CURRENT_RELEASE_DIR: options.releaseDir,
    BRIDGE_ACP_REVIEW_MODE: "1",
  };
  for (const key of Object.keys(env)) {
    if (RUN_SCOPED_AGENT_BRIDGE_ENV.test(key)) delete env[key];
  }
  env[`${options.provider.toUpperCase()}_EXECUTION_MODE`] = "safe";
  delete env[`${options.provider.toUpperCase()}_MODEL_PREFERENCE`];
  if (options.provider === "claude") delete env.CLAUDE_COMMAND;
  return env;
}

export type ReviewResult =
  | { result: "pass"; reviewedHead: string }
  | { result: "findings"; reviewedHead: string }
  | { result: "incomplete"; failure: "missing tools"; reviewerResult: "pass" | "findings" | null; missingToolKinds: string[]; reviewedHead: string | null };

export function buildReviewOutput(input: {
  implementer: string;
  provider: string;
  model: string;
  runtimeCommit: string;
  bridgeRunId: string;
  outwardSessionId: string;
  providerSessionIds: string[];
  qualified: ReviewResult;
  toolKinds: string[];
  text: string;
}): Record<string, unknown> {
  const { qualified, ...evidence } = input;
  return { ...evidence, ...qualified };
}

export function formatReviewResultFailure(reason: string): string {
  return `ACP reviewer review result failure: ${reason}`;
}

export function qualifyReviewResult(input: {
  text: string;
  expectedHead: string;
  toolKinds: readonly string[];
}): ReviewResult {
  const missingToolKinds = ["read", "search"].filter((kind) => !input.toolKinds.includes(kind));
  const heads = [...input.text.matchAll(/^REVIEWED_HEAD:\s*([a-f0-9]{40})\s*$/gim)].map((match) => match[1]);
  const results = [...input.text.matchAll(/^REVIEW_RESULT:\s*(PASS|FINDINGS)\s*$/gim)].map((match) => match[1]);
  if (heads.length !== 1 || results.length !== 1) {
    if (missingToolKinds.length > 0) {
      return {
        result: "incomplete",
        failure: "missing tools",
        reviewerResult: results.length === 1 ? results[0]!.toLowerCase() as "pass" | "findings" : null,
        missingToolKinds,
        reviewedHead: null,
      };
    }
    throw new Error("review result must contain exactly one qualified head and result");
  }
  const reviewedHead = heads[0];
  if (reviewedHead !== input.expectedHead) {
    throw new Error("review result is not bound to the exact candidate head");
  }
  const finalLine = input.text.trim().split(/\r?\n/).at(-1);
  if (finalLine !== `REVIEW_RESULT: ${results[0]}`) throw new Error("review result must be the final line");
  const precedingLine = input.text.trim().split(/\r?\n/).at(-2);
  if (precedingLine !== `REVIEWED_HEAD: ${reviewedHead}`) throw new Error("review markers must be the final two lines");
  const result = results[0];
  if (missingToolKinds.length > 0) {
    return {
      result: "incomplete",
      failure: "missing tools",
      reviewerResult: result.toLowerCase() as "pass" | "findings",
      missingToolKinds,
      reviewedHead,
    };
  }
  return { result: result.toLowerCase() as "pass" | "findings", reviewedHead };
}

function failureClass(dbPath: string, error: unknown, serverOutput = "", detail = ""): string {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : null;
  const runId = data && typeof data === "object" && typeof (data as { runId?: unknown }).runId === "string"
    ? (data as { runId: string }).runId
    : null;
  if (!runId) return classifyAcpReviewFailureFromEvidence(detail, serverOutput);
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT payload_json FROM bridge_events WHERE run_id = ? ORDER BY seq ASC").all(runId) as Array<{ payload_json: string }>;
    const diagnostic = rows.map((row) => JSON.parse(row.payload_json) as { type?: string; classification?: string })
      .reverse().find((event) => event.type === "run.diagnostic");
    switch (diagnostic?.classification) {
      case "auth_required": return "authentication";
      case "model_unavailable": return "unsupported model";
      case "capacity_exhausted": return "capacity";
      case "fatal":
      case "transient":
      case "unknown": return `provider ${diagnostic.classification}`;
      default: return classifyAcpReviewFailureFromEvidence(detail, serverOutput) ?? "provider execution";
    }
  } catch {
    return classifyAcpReviewFailureFromEvidence(detail, serverOutput);
  } finally {
    db?.close();
  }
}

export function classifyAcpReviewFailure(value: string): string | null {
  if (/authentication|auth required|not logged in|oauth|api key/i.test(value)) return "authentication";
  if (/unsupported model|model unavailable|\bmodel\b.{0,40}\b(?:not found|unknown|unavailable)\b/i.test(value)) return "unsupported model";
  if (/capacity|rate limit|quota|session limit/i.test(value)) return "capacity";
  if (/no available provider in (?:the )?configured chain|no available provider in chain|unsupported outward ACP provider lock/i.test(value)) return "provider unavailable";
  if (/spawn|enoent|exited before launch|command not found|executable.{0,20}not found/i.test(value)) return "launch";
  return null;
}

export function classifyAcpReviewFailureFromEvidence(detail: string, serverOutput = ""): string {
  const direct = classifyAcpReviewFailure(detail);
  if (direct) return direct;
  for (const line of serverOutput.split(/\r?\n/).reverse()) {
    if (!/error|failed|exception|no available provider|unsupported outward ACP provider lock|\bENOENT\b/i.test(line)) continue;
    const classification = classifyAcpReviewFailure(line);
    if (classification) return classification;
  }
  return "provider execution";
}

export function classifyUnavailableProviderStatus(input: {
  runtimeAvailable: boolean;
  credentialAvailable: boolean;
  authenticationDegraded: boolean;
}): string {
  if (!input.runtimeAvailable) return "launch";
  if (input.authenticationDegraded || !input.credentialAvailable) return "authentication";
  return "provider unavailable";
}

async function classifyUnavailableProvider(
  provider: ReviewProvider,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const providerId = provider === "antigravity" ? "agy" : provider;
  const home = env.HOME?.trim() || undefined;
  const authPaths = resolveInteractiveCliAuthPaths(home, env);
  const candidatePaths = authPaths[provider];
  const paths = Array.isArray(candidatePaths) ? candidatePaths : [candidatePaths];
  const credentialAvailable = paths.some((path) => typeof path === "string" && existsSync(path))
    || isProviderApiKeyConfigured(providerId, env);
  const authenticationDegraded = getProviderRuntimeAuthDegradedProviders(home).has(providerId);
  const command = resolveProviderRuntime(providerId, env).executable;
  const runtimeAvailable = isAbsolute(command) ? existsSync(command) : commandExistsOnPath(command);
  return classifyUnavailableProviderStatus({ runtimeAvailable, credentialAvailable, authenticationDegraded });
}

export function collectSuccessfulToolKinds(
  updates: readonly acp.SessionUpdate[],
  provider?: ReviewProvider,
  expectedCwd?: string,
): string[] {
  const calls = new Map<string, { kind: string | null; status: string | null }>();
  for (const update of updates) {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
    const candidate = update as {
      toolCall?: { toolCallId?: unknown; kind?: unknown; status?: unknown; rawInput?: unknown };
      toolCallId?: unknown;
      kind?: unknown;
      status?: unknown;
      rawInput?: unknown;
    };
    const id = candidate.toolCall?.toolCallId ?? candidate.toolCallId;
    if (typeof id !== "string") continue;
    const previous = calls.get(id) ?? { kind: null, status: null };
    const kind = candidate.toolCall?.kind ?? candidate.kind;
    const status = candidate.toolCall?.status ?? candidate.status;
    const rawInput = candidate.toolCall?.rawInput ?? candidate.rawInput;
    const codexKind = provider === "codex" && kind === "execute"
      ? codexReadOnlyRepositoryCommandKind(rawInput, expectedCwd)
      : null;
    calls.set(id, {
      kind: codexKind ?? (typeof kind === "string" ? kind : previous.kind),
      status: typeof status === "string" ? status : previous.status,
    });
  }
  return [...new Set([...calls.values()]
    .filter((call) => call.status === "completed" && call.kind !== null)
    .map((call) => call.kind!))];
}

function codexReadOnlyRepositoryCommandKind(rawInput: unknown, expectedCwd?: string): "read" | "search" | null {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const input = rawInput as { command?: unknown; cwd?: unknown };
  if (typeof input.command !== "string" || typeof input.cwd !== "string" || input.cwd !== expectedCwd) return null;
  // Codex ACP reports repository inspection through its execute event. Only
  // accept a single direct read/search command rooted in the review checkout;
  // the provider's read-only mode remains the write boundary.
  if (/[;&|<>`$()\\\r\n]/.test(input.command)) return null;
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  for (const character of input.command) {
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += character;
    }
  }
  if (quote) return null;
  if (word) words.push(word);
  if (words.some((part) => part.startsWith("/") || part.split("/").includes(".."))) return null;

  const [program, first, ...args] = words;
  if (program === "rg" || program === "grep") {
    if (words.slice(1).some((arg) => ["--pre", "--pre-glob", "--follow", "-L"].includes(arg))) return null;
    return words.slice(1).some((arg) => !arg.startsWith("-")) ? "search" : null;
  }
  if (program === "sed") {
    if (first !== "-n" || args.length < 2 || !/^(?:\d+(?:,\d+)?|\$)p$/.test(args[0] ?? "")) return null;
    return "read";
  }
  if (program === "cat" || program === "head" || program === "tail") {
    if (program !== "cat" && words.slice(1).some((arg) => ["-f", "--follow"].includes(arg))) return null;
    return args.some((arg) => !arg.startsWith("-") && arg !== "-") ? "read" : null;
  }
  if (program !== "git") return null;
  const subcommand = first === "-c" && args[0] === "core.hooksPath=/dev/null" ? args[1] : first;
  const gitArgs = first === "-c" ? args.slice(2) : args;
  if (gitArgs.some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "-o")) return null;
  if (["show", "diff", "cat-file"].includes(subcommand ?? "")) return "read";
  if (subcommand === "grep") return "search";
  return null;
}

export function joinReviewMessageParts(parts: readonly (string | null)[]): string {
  let text = "";
  let separatedByTool = false;
  for (const part of parts) {
    if (part === null) {
      separatedByTool = true;
      continue;
    }
    if (separatedByTool && text && !text.endsWith("\n") && !part.startsWith("\n")) text += "\n";
    text += part;
    separatedByTool = false;
  }
  return text;
}

export function findReviewRunId(db: Database.Database, sessionId: string): string | null {
  const session = db.prepare(`
    SELECT conversation_id FROM outward_acp_sessions WHERE session_id = ?
  `).get(sessionId) as { conversation_id?: string } | undefined;
  if (!session?.conversation_id) return null;
  const run = db.prepare(`
    SELECT run_id FROM bridge_runs
    WHERE chat_id = ? AND surface_identity = 'acp:outward'
    ORDER BY started_at DESC LIMIT 1
  `).get(session.conversation_id) as { run_id?: string } | undefined;
  return run?.run_id ?? null;
}

export function openReadOnlyReviewDatabase(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function bridgeRunIdFromError(error: unknown): string | null {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : null;
  return data && typeof data === "object" && typeof (data as { runId?: unknown }).runId === "string"
    ? (data as { runId: string }).runId
    : null;
}

interface CliOptions {
  provider: ReviewProvider;
  head: string;
  cwd: string;
  promptFile: string;
  timeoutMs: number;
}

const DEFAULT_REVIEW_TIMEOUT_SECONDS = 1_800;
const REVIEW_CLOSE_GRACE_MARGIN_MS = 1_000;
const REVIEW_CANCEL_GRACE_MS = 1_000;
const GIT_TIMEOUT_MS = 120_000;
const REVIEW_KILL_GRACE_MS = 2_000;

/** The release that contains this helper; never a caller-selected directory. */
export const HELPER_RELEASE_DIR = fileURLToPath(new URL("..", import.meta.url));

export function reviewRuntime(configured: string, candidateHead: string): { root: string; commit: string } {
  let root: string;
  try {
    root = realpathSync(configured);
  } catch {
    throw new Error("installed Agent Bridge release directory cannot be resolved");
  }
  const manifestPath = join(root, "manifest.json");
  const runtimeServer = join(root, "dist/acpServer/stdio.js");
  if (!existsSync(manifestPath) || !existsSync(runtimeServer)) {
    throw new Error("installed Agent Bridge release runtime is incomplete");
  }
  let manifest: { commit?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { commit?: unknown };
  } catch {
    throw new Error("installed Agent Bridge release manifest is invalid");
  }
  const commit = typeof manifest.commit === "string" ? manifest.commit : "";
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("installed Agent Bridge release commit is invalid");
  if (commit === candidateHead) throw new Error("review runtime must be independent of the candidate commit");
  return { root, commit };
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    values.set(key, value);
    index += 1;
  }
  const provider = values.get("--provider") as ReviewProvider | undefined;
  if (!provider || !["claude", "codex", "antigravity", "grok", "cursor"].includes(provider)) {
    throw new Error("--provider must name a supported ACP provider");
  }
  const head = values.get("--head") ?? "";
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("--head must be a full candidate commit SHA");
  const cwd = resolve(values.get("--cwd") ?? process.cwd());
  if (!isAbsolute(cwd)) throw new Error("--cwd must be an absolute path");
  const promptFile = values.get("--prompt-file");
  if (!promptFile) throw new Error("--prompt-file is required");
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? DEFAULT_REVIEW_TIMEOUT_SECONDS);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error("--timeout-seconds must be a positive integer");
  return { provider, head, cwd, promptFile: resolve(promptFile), timeoutMs: timeoutSeconds * 1_000 };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL",
  }).trim();
}

/** The reviewer sees only the committed tree: a fresh detached worktree at the exact head. */
export async function createReviewCheckout(repository: string, head: string): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), "agent-bridge-review-"));
  try {
    git(repository, ["worktree", "add", "--detach", "--quiet", checkout, `${head}^{commit}`]);
    verifyReviewCheckout(checkout, head);
    return checkout;
  } catch (error) {
    await removeReviewCheckout(repository, checkout);
    throw error;
  }
}

export function verifyReviewCheckout(checkout: string, head: string): void {
  const observed = git(checkout, ["rev-parse", "HEAD"]);
  if (observed !== head) throw new Error(`candidate checkout mismatch: expected ${head}, found ${observed}`);
  if (git(checkout, ["status", "--porcelain", "--untracked-files=all", "--ignored=no"])) {
    throw new Error("candidate checkout changed during review");
  }
}

export async function removeReviewCheckout(repository: string, checkout: string): Promise<void> {
  try { git(repository, ["worktree", "remove", "--force", checkout]); } catch { /* not registered */ }
  await rm(checkout, { recursive: true, force: true });
  try { git(repository, ["worktree", "prune"]); } catch { /* best effort */ }
}

async function reviewPrompt(promptFile: string, provider: ReviewProvider, expectedHead: string, runtimeCommit: string): Promise<string> {
  const request = (await readFile(promptFile, "utf8")).trim();
  if (!request) throw new Error("review prompt is empty");
  const repositoryTools = provider === "codex"
    ? "Use the provider's native repository read and search tools. Codex may use its read-only repository inspection tool for these operations, with one command per call and no shell operators or command chaining. Do not modify files, use network access, or request permission escalation. If read or search is unavailable, report which capability is missing."
    : "Use both ACP repository tools categorized as read and search. If either category is unavailable, stop and report which one is missing.";
  return [
    request,
    "",
    `The working directory is a clean detached checkout of commit ${expectedHead} created by the launcher; it contains only that committed tree.`,
    `The Agent Bridge ACP server and review helper are running from installed release commit ${runtimeCommit}.`,
    `Read the repository instructions and inspect the candidate yourself. ${repositoryTools} Do not commit, push, merge, deploy, or change infrastructure.`,
    `After all review findings, put exactly one line REVIEWED_HEAD: ${expectedHead} followed by exactly one line REVIEW_RESULT: PASS or REVIEW_RESULT: FINDINGS as the final two lines. Include actionable findings before these markers.`,
  ].join("\n");
}

async function runReview(options: CliOptions): Promise<void> {
  const origin = resolveImplementingRun();
  const dbPath = origin.dbPath;
  const originDb = openReadOnlyReviewDatabase(dbPath);
  let implementer: string;
  try {
    implementer = readImplementingProvider(originDb, origin.runId, origin.bot);
  } finally {
    originDb.close();
  }
  const runtime = reviewRuntime(HELPER_RELEASE_DIR, options.head);
  const childEnv = buildAcpReviewEnvironment({
    provider: options.provider,
    implementer,
    base: { ...process.env, DB_PATH: dbPath },
    releaseDir: runtime.root,
  });
  const repository = git(options.cwd, ["rev-parse", "--show-toplevel"]);
  const checkout = await createReviewCheckout(repository, options.head);
  try {
    await runReviewSession(options, { implementer, dbPath, runtime, childEnv, checkout });
    verifyReviewCheckout(checkout, options.head);
  } finally {
    await removeReviewCheckout(repository, checkout);
  }
}

async function runReviewSession(
  options: CliOptions,
  context: { implementer: string; dbPath: string; runtime: { root: string; commit: string }; childEnv: NodeJS.ProcessEnv; checkout: string },
): Promise<void> {
  const { implementer, dbPath, runtime, childEnv } = context;
  const prompt = await reviewPrompt(options.promptFile, options.provider, options.head, runtime.commit);
  let child: ChildProcess | null = null;
  let providerSessionId: string | null = null;
  const toolUpdates: acp.SessionUpdate[] = [];
  const messageParts: Array<string | null> = [];
  const serverOutput: string[] = [];
  let stopReason: string | null = null;
  let deadline: NodeJS.Timeout | null = null;
  let cancelled: string | null = null;
  const acpCancellation: { cancel: (() => Promise<void>) | null } = { cancel: null };
  const stopSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  let interrupt: (reason: string) => void = () => undefined;
  const onSignal = (signal: NodeJS.Signals) => interrupt(`interrupted by ${signal}`);

  try {
    try {
      child = spawn(process.execPath, [join(runtime.root, "dist/acpServer/stdio.js")], {
        cwd: runtime.root,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        serverOutput.push(chunk.toString("utf8"));
        if (serverOutput.join("").length > 16_384) serverOutput.shift();
      });
      await new Promise<void>((resolveReady, rejectReady) => {
        child!.once("spawn", () => resolveReady());
        child!.once("error", rejectReady);
        child!.once("exit", (code) => {
          if (code !== null) rejectReady(new Error(`ACP review server exited before launch (${code})`));
        });
      });
      if (!child.stdin || !child.stdout) throw new Error("ACP review server did not provide stdio pipes");
    } catch {
      throw new Error("ACP reviewer launch failure");
    }
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = (reason) => {
        if (cancelled) return;
        cancelled = reason;
        reject(new Error(`ACP reviewer ${reason}`));
      };
    });
    interrupted.catch(() => undefined);
    deadline = setTimeout(() => interrupt(`timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    for (const signal of stopSignals) process.once(signal, onSignal);
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    let result: string | undefined;
    try {
      const review = acp.client({ name: "agent-bridge-review-client" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "agent-bridge-review-client", version: "1" },
        });
        if (cancelled) throw new Error(`ACP reviewer ${cancelled}`);
        return ctx.buildSession({ cwd: context.checkout, mcpServers: [] }).withSession(async (session) => {
          providerSessionId = session.sessionId;
          acpCancellation.cancel = async () => {
            try { await ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }); } catch { /* teardown still closes the transport */ }
          };
          if (cancelled) {
            await acpCancellation.cancel();
            throw new Error(`ACP reviewer ${cancelled}`);
          }
          const promptResult = session.prompt(prompt);
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") {
              stopReason = message.stopReason;
              break;
            }
            if (message.update.sessionUpdate === "tool_call" || message.update.sessionUpdate === "tool_call_update") {
              toolUpdates.push(message.update);
              messageParts.push(null);
            }
            const update = message.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              messageParts.push(update.content.text);
            }
          }
          await promptResult;
          return joinReviewMessageParts(messageParts);
        });
      });
      // Teardown after an interrupt rejects the abandoned client; that is expected.
      review.catch(() => undefined);
      result = await Promise.race([interrupted, review]);
    } catch (error) {
      if (cancelled) throw new Error(`ACP reviewer ${cancelled}${providerSessionId ? ` (ACP session ${providerSessionId})` : ""}`);
      const detail = error instanceof Error ? error.message : "ACP request failed";
      let classification = failureClass(dbPath, error, serverOutput.join(""), detail);
      if (classification === "provider unavailable") {
        classification = await classifyUnavailableProvider(options.provider, childEnv);
      }
      const runId = bridgeRunIdFromError(error);
      throw new Error(`ACP reviewer ${classification} failure${runId ? ` (Bridge Run ${runId})` : ""}`);
    }

    if (stopReason !== "end_turn") throw new Error(`reviewer stopped without a completed turn (${stopReason ?? "unknown"})`);
    const text = result ?? joinReviewMessageParts(messageParts);
    const observedToolKinds = collectSuccessfulToolKinds(toolUpdates, options.provider, context.checkout);
    const db = openReadOnlyReviewDatabase(dbPath);
    let runId: string | null = null;
    let actualProvider: string = options.provider;
    let model: string | null = null;
    let innerSessionIds: string[] = [];
    try {
      runId = providerSessionId ? findReviewRunId(db, providerSessionId) : null;
      if (runId) {
        const events = db.prepare("SELECT payload_json FROM bridge_events WHERE run_id = ? ORDER BY seq ASC").all(runId) as Array<{ payload_json: string }>;
        for (const event of events) {
          const payload = JSON.parse(event.payload_json) as { type?: string; bot?: string; model?: string; telemetry?: { model?: string }; event?: { acpSessionId?: unknown } };
          if (payload.type === "run.started" || payload.type === "run.completed") {
            actualProvider = payload.bot ?? actualProvider;
            model = payload.model ?? payload.telemetry?.model ?? model;
          }
          if (payload.type === "acp.event") {
            const acpId = payload.event?.acpSessionId;
            if (typeof acpId === "string" && !innerSessionIds.includes(acpId)) innerSessionIds.push(acpId);
          }
        }
        const run = db.prepare("SELECT status, bot FROM bridge_runs WHERE run_id = ?").get(runId) as { status?: string; bot?: string } | undefined;
        if (run?.status !== "done") throw new Error(`ACP reviewer Bridge Run ended with ${run?.status ?? "unknown"}`);
        if (run.bot !== options.provider) throw new Error(`Bridge Run provider mismatch: expected ${options.provider}, got ${run.bot}`);
      }
    } finally {
      db.close();
    }
    if (!runId) throw new Error("Bridge did not record an independent review Run");
    if (!providerSessionId) throw new Error("Bridge did not return an independent review ACP session");
    if (actualProvider !== options.provider) throw new Error(`provider lock mismatch: expected ${options.provider}, got ${actualProvider}`);
    let qualified: ReviewResult;
    try {
      qualified = qualifyReviewResult({ text, expectedHead: options.head, toolKinds: observedToolKinds });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "malformed review output";
      throw new Error(formatReviewResultFailure(reason));
    }

    process.stdout.write(`${JSON.stringify(buildReviewOutput({
      implementer,
      provider: actualProvider,
      model: model ?? "provider-default",
      runtimeCommit: runtime.commit,
      bridgeRunId: runId,
      outwardSessionId: providerSessionId,
      providerSessionIds: innerSessionIds,
      qualified,
      toolKinds: observedToolKinds,
      text,
    }), null, 2)}\n`);
    if (qualified.result === "incomplete") process.exitCode = 1;
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const signal of stopSignals) process.off(signal, onSignal);
    if (child) {
      if (cancelled && acpCancellation.cancel) {
        let cancelTimer: NodeJS.Timeout | null = null;
        try {
          await Promise.race([
            acpCancellation.cancel(),
            new Promise<void>((resolveCancel) => { cancelTimer = setTimeout(resolveCancel, REVIEW_CANCEL_GRACE_MS); }),
          ]);
        } finally {
          if (cancelTimer) clearTimeout(cancelTimer);
        }
      }
      // Closing stdin lets the ACP server cancel and finalize its Bridge Run;
      // after a bounded wait, reuse the supervisor's SIGTERM -> SIGKILL
      // process-group teardown.
      const exited = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
      try { child.stdin?.end(); } catch { /* already closed */ }
      // Let the Bridge server finish its own SIGTERM -> SIGKILL provider cleanup
      // before terminating the server process group that owns that cleanup.
      const serverCloseGraceMs = killChildTreeWaitBoundMs(childEnv) + REVIEW_CLOSE_GRACE_MARGIN_MS;
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, serverCloseGraceMs).unref())]);
      await killChildTree(child, REVIEW_KILL_GRACE_MS);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runReview(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "ACP review invocation failed";
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
}
