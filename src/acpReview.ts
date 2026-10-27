#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
    BRIDGE_PROJECT_DIR: options.projectDir,
    BRIDGE_CURRENT_RELEASE_DIR: options.releaseDir,
  };
  env[`${options.provider.toUpperCase()}_EXECUTION_MODE`] = "safe";
  delete env[`${options.provider.toUpperCase()}_MODEL_PREFERENCE`];
  if (options.provider === "claude") delete env.CLAUDE_COMMAND;
  return env;
}

export type ReviewResult = { result: "pass"; reviewedHead: string } | { result: "findings"; reviewedHead: string };

export function qualifyReviewResult(input: {
  text: string;
  expectedHead: string;
  toolKinds: readonly string[];
}): ReviewResult {
  if (!input.toolKinds.some((kind) => kind === "read" || kind === "search")) {
    throw new Error("independent reviewer did not use repository read/search tools");
  }
  const heads = [...input.text.matchAll(/^REVIEWED_HEAD:\s*([a-f0-9]{40})\s*$/gim)].map((match) => match[1]);
  const results = [...input.text.matchAll(/^REVIEW_RESULT:\s*(PASS|FINDINGS)\s*$/gim)].map((match) => match[1]);
  if (heads.length !== 1 || results.length !== 1) {
    throw new Error("review result must contain exactly one qualified head and result");
  }
  const reviewedHead = heads[0];
  if (reviewedHead !== input.expectedHead) {
    throw new Error("review result is not bound to the exact candidate head");
  }
  const finalLine = input.text.trim().split(/\r?\n/).at(-1);
  if (finalLine !== `REVIEW_RESULT: ${results[0]}`) throw new Error("review result must be the final line");
  const result = results[0];
  return { result: result.toLowerCase() as "pass" | "findings", reviewedHead };
}

function failureClass(dbPath: string, error: unknown, serverOutput = ""): string {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : null;
  const runId = data && typeof data === "object" && typeof (data as { runId?: unknown }).runId === "string"
    ? (data as { runId: string }).runId
    : null;
  if (!runId) return classifyAcpReviewFailure(serverOutput) ?? "launch";
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
      default: return classifyAcpReviewFailure(serverOutput) ?? "provider execution";
    }
  } catch {
    return "provider execution";
  } finally {
    db?.close();
  }
}

export function classifyAcpReviewFailure(value: string): string | null {
  if (/authentication|auth required|not logged in|oauth|api key/i.test(value)) return "authentication";
  if (/unsupported model|model unavailable/i.test(value)) return "unsupported model";
  if (/capacity|rate limit|quota|session limit/i.test(value)) return "capacity";
  if (/no available provider in (?:the )?configured chain|no available provider in chain/i.test(value)) return "provider unavailable";
  if (/spawn|not found|enoent|exited before launch/i.test(value)) return "launch";
  return null;
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

function safeErrorHints(value: string): string {
  return value.split(/\r?\n/)
    .filter((line) => /error|failed|exception|unsupported/i.test(line))
    .map((line) => line.replace(/(token|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]"))
    .slice(-3)
    .join(" | ")
    .slice(0, 600);
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
  const root = resolve(configured);
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

async function reviewPrompt(promptFile: string, expectedHead: string): Promise<string> {
  const request = (await readFile(promptFile, "utf8")).trim();
  if (!request) throw new Error("review prompt is empty");
  return [
    request,
    "",
    `The exact candidate commit is ${expectedHead}. Verify the output of git rev-parse HEAD matches this value before reviewing.`,
    "Read the repository instructions and inspect the candidate yourself. Use repository read/search tools. Do not modify files, commit, push, merge, deploy, or change infrastructure.",
    `Finish with exactly one line REVIEWED_HEAD: ${expectedHead} and one line REVIEW_RESULT: PASS or REVIEW_RESULT: FINDINGS. Include actionable findings when present.`,
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
  const prompt = await reviewPrompt(options.promptFile, options.head);
  let child: ChildProcess | null = null;
  let providerSessionId: string | null = null;
  const toolUpdates: acp.SessionUpdate[] = [];
  const chunks: string[] = [];
  const serverOutput: string[] = [];
  let stopReason: string | null = null;

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
            }
            const update = message.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              chunks.push(update.content.text);
            }
          }
          await promptResult;
          return chunks.join("");
        });
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "ACP request failed";
      const classification = failureClass(dbPath, error, `${serverOutput.join("")}\n${detail}`);
      const runId = bridgeRunIdFromError(error);
      const hints = safeErrorHints(serverOutput.join(""));
      throw new Error(`ACP reviewer ${classification} failure${runId ? ` (Bridge Run ${runId})` : ""}: ${detail}${hints ? `; ${hints}` : ""}`);
    }

    if (stopReason !== "end_turn") throw new Error(`reviewer stopped without a completed turn (${stopReason ?? "unknown"})`);
    const text = result ?? chunks.join("");
    const observedToolKinds = collectSuccessfulToolKinds(toolUpdates);
    const runtimeDb = await import(pathToFileURL(join(runtime.root, "dist/db.js")).href);
    const { openProductionDb } = runtimeDb as typeof import("./db.js");
    const db = openProductionDb(dbPath, { serviceId: "acp:review-result", databaseRole: "interactive" });
    let runId: string | null = null;
    let actualProvider = options.provider;
    let model: string | null = null;
    let innerSessionIds: string[] = [];
    try {
      runId = providerSessionId ? findReviewRunId(db.raw, providerSessionId) : null;
      if (runId) {
        const events = db.getEventsForRun(runId);
        for (const event of events) {
          const payload = typeof event.payload_json === "string" ? JSON.parse(event.payload_json) : event.payload_json;
          if (payload.type === "run.started" || payload.type === "run.completed") {
            actualProvider = payload.bot ?? actualProvider;
            model = payload.model ?? payload.telemetry?.model ?? model;
          }
          if (payload.type === "acp.event") {
            const acpId = payload.event?.acpSessionId;
            if (typeof acpId === "string" && !innerSessionIds.includes(acpId)) innerSessionIds.push(acpId);
          }
        }
        const run = db.getRun(runId);
        if (run?.status !== "done") throw new Error(`ACP reviewer Bridge Run ended with ${run?.status ?? "unknown"}`);
        if (run.bot !== options.provider) throw new Error(`Bridge Run provider mismatch: expected ${options.provider}, got ${run.bot}`);
      }
    } finally {
      db.close();
    }
    if (!runId) throw new Error("Bridge did not record an independent review Run");
    if (actualProvider !== options.provider) throw new Error(`provider lock mismatch: expected ${options.provider}, got ${actualProvider}`);
    const qualified = qualifyReviewResult({ text, expectedHead: options.head, toolKinds: observedToolKinds });

    process.stdout.write(`${JSON.stringify({
      implementer,
      provider: actualProvider,
      model: model ?? "provider-default",
      runtimeCommit: runtime.commit,
      bridgeRunId: runId,
      outwardSessionId: providerSessionId,
      providerSessionIds: innerSessionIds,
      reviewedHead: qualified.reviewedHead,
      result: qualified.result,
      toolKinds: observedToolKinds,
      text,
    }, null, 2)}\n`);
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
