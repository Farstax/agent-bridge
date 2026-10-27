#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import Database from "better-sqlite3";

export type ReviewProvider = "claude" | "codex" | "antigravity" | "grok" | "cursor";

export interface ReviewInvocationOptions {
  provider: ReviewProvider;
  implementer: string;
  base: Record<string, string | undefined>;
  projectDir: string;
  releaseDir: string;
}

const RUN_SCOPED_AGENT_BRIDGE_ENV = /^AGENT_BRIDGE_(?:RUN_ID|SERVICE_ID|ACQUISITION_ID|LOCK_|OUTCOME_COMMAND|WAIT_COMMAND|SCRATCH_COMMAND|CHAT_KEY|SURFACE_IDENTITY|OWNER_KEY|CONTEXT_(?:DB|AVAILABLE|COMMAND)|DELIVERY_)/;


export function buildAcpReviewEnvironment(options: ReviewInvocationOptions): NodeJS.ProcessEnv {
  if (options.provider === options.implementer) {
    throw new Error("independent review requires a different provider");
  }
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
  releaseRoot: string,
): Promise<string> {
  try {
    const providerId = provider === "antigravity" ? "agy" : provider;
    const [auth, apiKeyAuth, runtimeAvailability, acpRuntime] = await Promise.all([
      import(pathToFileURL(join(releaseRoot, "dist/interactiveCliAuth.js")).href),
      import(pathToFileURL(join(releaseRoot, "dist/providers/apiKeyAuth.js")).href),
      import(pathToFileURL(join(releaseRoot, "dist/providers/runtimeAvailability.js")).href),
      import(pathToFileURL(join(releaseRoot, "dist/providers/acpRuntime.js")).href),
    ]);
    const home = env.HOME?.trim() || undefined;
    const authPaths = auth.resolveInteractiveCliAuthPaths(home, env) as Record<string, string | string[]>;
    const candidatePaths = authPaths[provider] ?? [];
    const paths = Array.isArray(candidatePaths) ? candidatePaths : [candidatePaths];
    const credentialAvailable = paths.some((path) => typeof path === "string" && existsSync(path))
      || apiKeyAuth.isProviderApiKeyConfigured(providerId, env);
    const authenticationDegraded = runtimeAvailability.getProviderRuntimeAuthDegradedProviders(home).has(providerId);
    const command = acpRuntime.resolveProviderRuntime(providerId, env).executable as string;
    const runtimeAvailable = isAbsolute(command) ? existsSync(command) : commandExists(command);
    return classifyUnavailableProviderStatus({ runtimeAvailable, credentialAvailable, authenticationDegraded });
  } catch {
    return "provider unavailable";
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function collectSuccessfulToolKinds(updates: readonly acp.SessionUpdate[]): string[] {
  const calls = new Map<string, { kind: string | null; status: string | null }>();
  for (const update of updates) {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
    const candidate = update as { toolCall?: { toolCallId?: unknown; kind?: unknown; status?: unknown }; toolCallId?: unknown; kind?: unknown; status?: unknown };
    const id = candidate.toolCall?.toolCallId ?? candidate.toolCallId;
    if (typeof id !== "string") continue;
    const previous = calls.get(id) ?? { kind: null, status: null };
    const kind = candidate.toolCall?.kind ?? candidate.kind;
    const status = candidate.toolCall?.status ?? candidate.status;
    calls.set(id, {
      kind: typeof kind === "string" ? kind : previous.kind,
      status: typeof status === "string" ? status : previous.status,
    });
  }
  return [...new Set([...calls.values()]
    .filter((call) => call.status === "completed" && call.kind !== null)
    .map((call) => call.kind!))];
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
}

export function reviewRuntime(base: NodeJS.ProcessEnv, candidateHead: string): { root: string; commit: string } {
  const configured = base.BRIDGE_CURRENT_RELEASE_DIR?.trim();
  if (!configured) throw new Error("installed Agent Bridge release directory is unavailable");
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
  return { provider, head, cwd, promptFile: resolve(promptFile) };
}

function currentHead(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

async function reviewPrompt(promptFile: string, expectedHead: string, runtimeCommit: string): Promise<string> {
  const request = (await readFile(promptFile, "utf8")).trim();
  if (!request) throw new Error("review prompt is empty");
  return [
    request,
    "",
    `The exact candidate commit is ${expectedHead}. Verify the output of git rev-parse HEAD matches this value before reviewing.`,
    `The Agent Bridge ACP server and review helper are running from installed release commit ${runtimeCommit}.`,
    "Read the repository instructions and inspect the candidate yourself. Use both ACP repository tools categorized as read and search. Do not use shell/Bash/execute as a substitute. If either category is unavailable, stop and report which one is missing. Do not modify files, commit, push, merge, deploy, or change infrastructure.",
    `After all review findings, put exactly one line REVIEWED_HEAD: ${expectedHead} followed by exactly one line REVIEW_RESULT: PASS or REVIEW_RESULT: FINDINGS as the final two lines. Include actionable findings before these markers.`,
  ].join("\n");
}

async function runReview(options: CliOptions): Promise<void> {
  const observedHead = currentHead(options.cwd);
  if (observedHead !== options.head) throw new Error(`candidate checkout mismatch: expected ${options.head}, found ${observedHead}`);
  const implementer = process.env.AGENT_BRIDGE_PROVIDER?.trim();
  if (!implementer) throw new Error("Agent Bridge implementer provider is unavailable in this environment");
  const runtime = reviewRuntime(process.env, options.head);
  const dbPath = process.env.DB_PATH?.trim();
  if (!dbPath) throw new Error("DB_PATH is required for durable Bridge review evidence");
  const childEnv = buildAcpReviewEnvironment({
    provider: options.provider,
    implementer,
    base: process.env,
    projectDir: options.cwd,
    releaseDir: runtime.root,
  });
  const prompt = await reviewPrompt(options.promptFile, options.head, runtime.commit);
  let child: ChildProcess | null = null;
  let providerSessionId: string | null = null;
  const toolUpdates: acp.SessionUpdate[] = [];
  const messageParts: Array<string | null> = [];
  const serverOutput: string[] = [];
  let stopReason: string | null = null;

  try {
    try {
      child = spawn(process.execPath, [join(runtime.root, "dist/acpServer/stdio.js")], {
        cwd: runtime.root,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
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
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    let result: string | undefined;
    try {
      result = await acp.client({ name: "agent-bridge-review-client" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "agent-bridge-review-client", version: "1" },
        });
        return ctx.buildSession({ cwd: options.cwd, mcpServers: [] }).withSession(async (session) => {
          providerSessionId = session.sessionId;
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
    } catch (error) {
      const detail = error instanceof Error ? error.message : "ACP request failed";
      let classification = failureClass(dbPath, error, serverOutput.join(""), detail);
      if (classification === "provider unavailable") {
        classification = await classifyUnavailableProvider(options.provider, childEnv, runtime.root);
      }
      const runId = bridgeRunIdFromError(error);
      throw new Error(`ACP reviewer ${classification} failure${runId ? ` (Bridge Run ${runId})` : ""}`);
    }

    if (stopReason !== "end_turn") throw new Error(`reviewer stopped without a completed turn (${stopReason ?? "unknown"})`);
    const text = result ?? joinReviewMessageParts(messageParts);
    const observedToolKinds = collectSuccessfulToolKinds(toolUpdates);
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
    const qualified = qualifyReviewResult({ text, expectedHead: options.head, toolKinds: observedToolKinds });

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
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        if (child!.exitCode !== null) resolveExit();
        else child!.once("exit", () => resolveExit());
      });
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
