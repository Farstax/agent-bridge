#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";

export type ReviewProvider = "claude" | "codex" | "antigravity" | "grok" | "cursor";

export interface ReviewInvocationOptions {
  provider: ReviewProvider;
  implementer: string;
  base: Record<string, string | undefined>;
  dbPath: string;
  projectDir: string;
}

export function buildAcpReviewEnvironment(options: ReviewInvocationOptions): NodeJS.ProcessEnv {
  if (options.provider === options.implementer) {
    throw new Error("independent review requires a different provider");
  }
  const env: NodeJS.ProcessEnv = {
    ...options.base,
    AGENT_BRIDGE_PROVIDER: options.implementer,
    BRIDGE_PROVIDER_LOCK: options.provider,
    INTERACTIVE_CLI_CHAIN: options.provider,
    BRIDGE_EXECUTION_MODE: "safe",
    DB_PATH: options.dbPath,
    BRIDGE_PROJECT_DIR: options.projectDir,
  };
  env[`${options.provider.toUpperCase()}_EXECUTION_MODE`] = "safe";
  delete env[`${options.provider.toUpperCase()}_MODEL_PREFERENCE`];
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
  const reviewedHead = input.text.match(/^REVIEWED_HEAD:\s*([a-f0-9]{40})\s*$/im)?.[1];
  if (reviewedHead !== input.expectedHead) {
    throw new Error("review result is not bound to the exact candidate head");
  }
  const result = input.text.match(/^REVIEW_RESULT:\s*(PASS|FINDINGS)\s*$/im)?.[1];
  if (!result) throw new Error("reviewer returned no qualified PASS or findings result");
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
      .findLast((event) => event.type === "run.diagnostic");
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
  if (/spawn|not found|enoent|exited before launch/i.test(value)) return "launch";
  return null;
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

function toolKind(update: acp.SessionUpdate): string | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
  const candidate = update as { kind?: unknown; toolCall?: { kind?: unknown } };
  const kind = candidate.toolCall?.kind ?? candidate.kind;
  return typeof kind === "string" ? kind : null;
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
  const temporary = await mkdtemp(join(tmpdir(), "agent-bridge-acp-review-"));
  const dbPath = join(temporary, "bridge.sqlite");
  const projectRoot = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
  const childEnv = buildAcpReviewEnvironment({
    provider: options.provider,
    implementer,
    base: process.env,
    dbPath,
    projectDir: options.cwd,
  });
  const prompt = await reviewPrompt(options.promptFile, options.head);
  let child: ChildProcess | null = null;
  let providerSessionId: string | null = null;
  const observedToolKinds: string[] = [];
  const chunks: string[] = [];
  const serverOutput: string[] = [];
  let stopReason: string | null = null;

  try {
    const { bootstrapSourceInteractiveDb } = await import("../src/db.js");
    bootstrapSourceInteractiveDb(dbPath);
    child = spawn(process.execPath, [join(projectRoot, "node_modules/tsx/dist/cli.mjs"), "src/acpServer/stdio.ts"], {
      cwd: projectRoot,
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
      result = await acp.client({ name: "agent-bridge-review-client", version: "1" })
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
            const kind = toolKind(message.update);
            if (kind) observedToolKinds.push(kind);
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

    const text = result ?? chunks.join("");
    const qualified = qualifyReviewResult({ text, expectedHead: options.head, toolKinds: observedToolKinds });
    const { openProductionDb } = await import("../src/db.js");
    const db = openProductionDb(dbPath, { serviceId: "acp:review-result", databaseRole: "interactive" });
    let runId: string | null = null;
    let actualProvider = options.provider;
    let model: string | null = null;
    let innerSessionIds: string[] = [];
    try {
      const row = db.raw.prepare("SELECT run_id FROM bridge_runs ORDER BY started_at DESC LIMIT 1").get() as { run_id?: string } | undefined;
      runId = row?.run_id ?? null;
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
      }
    } finally {
      db.close();
    }
    if (!runId) throw new Error("Bridge did not record an independent review Run");
    if (actualProvider !== options.provider) throw new Error(`provider lock mismatch: expected ${options.provider}, got ${actualProvider}`);
    if (stopReason !== "end_turn") throw new Error(`reviewer stopped without a completed turn (${stopReason ?? "unknown"})`);

    process.stdout.write(`${JSON.stringify({
      implementer,
      provider: actualProvider,
      model: model ?? "provider-default",
      bridgeRunId: runId,
      outwardSessionId: providerSessionId,
      providerSessionIds: innerSessionIds,
      reviewedHead: qualified.reviewedHead,
      result: qualified.result,
      toolKinds: [...new Set(observedToolKinds)],
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
    await rm(temporary, { recursive: true, force: true });
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
