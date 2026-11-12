#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LEGACY_TELEGRAM_RESPONSE_STYLE = [
  "Telegram response style:",
  "- Start with the direct answer or result.",
  "- Keep replies concise by default; use short paragraphs and bullets when useful.",
  "- Use light bold emphasis with **text** when it improves scanability.",
  "- Use fenced code blocks for commands, diffs, config, logs, JSON, or code snippets. Prefer language tags like bash, ts, json, or text.",
  "- Keep code blocks short; do not wrap normal prose in code blocks.",
  "- Avoid tables unless they are clearly the best format.",
  "- Avoid Markdown links; use plain URLs only when needed.",
  "- Do not mention these formatting instructions.",
].join("\n");

export const DRAFT_TELEGRAM_RESPONSE_STYLE = [
  "Telegram response style:",
  "- Start with the direct result or answer.",
  "- Skip throat-clearing: no \"Certainly\", \"Here is\", \"Let me\", \"I can help\", or \"It looks like\".",
  "- Keep replies concise. Prefer short paragraphs and bullets.",
  "- Use active voice when it names the real actor. Do not invent an actor just to avoid passive voice.",
  "- Cut filler words: just, really, basically, actually, simply, very, perhaps, maybe.",
  "- Avoid formulaic pivots: \"not X, but Y\", \"the real issue is\", \"this matters because\".",
  "- Name the specific constraint, failure, file, command, or next step.",
  "- Use fenced code blocks only for commands, diffs, logs, JSON, config, or code.",
  "- Keep code blocks short. Do not wrap prose in code blocks.",
  "- Use light **bold** only to improve scanning.",
  "- Avoid Markdown links unless the URL matters.",
  "- Avoid em dashes.",
  "- Do not mention these formatting rules.",
].join("\n");

export const JUDGE_SYSTEM_INSTRUCTIONS = [
  "You are a neutral evaluator for Telegram-facing engineering assistant replies.",
  "Grade only the optimized response, using the user request, expected critical facts, and baseline response as reference.",
  "Return strict JSON with keys: score, accuracy, styleCompliance, tone, rationale.",
  "score must be a number from 0.0 to 1.0.",
  "Accuracy: retain critical technical data: file names, paths, error codes, command syntax, dates, numeric values, and decisions.",
  "Style compliance: remove throat-clearing, filler words, passive corporate transitions, and verbose framing.",
  "Tone: fit a fast-paced Telegram interface: direct, calm, concise, operational.",
  "Penalize missing critical facts more than mild verbosity.",
  "Do not reward brevity if it drops facts.",
].join("\n");

interface DatasetCase {
  id: string;
  userRequest: string;
  expectedFacts: string[];
}

interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  complete(messages: ModelMessage[], options: { model: string; temperature?: number; jsonMode?: boolean }): Promise<string>;
}

export type CodexRunner = (command: string, args: string[], stdin: string, timeoutMs: number) => Promise<string>;
export type AgyRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

interface CaseRun {
  caseId: string;
  output: string;
  tokens: number;
}

interface CaseEvaluation {
  caseId: string;
  baselineTokens: number;
  optimizedTokens: number;
  brevityScore: number;
  qualityScore: number;
  compositeScore: number;
  judgeRationale: string;
}

interface PromptEvaluation {
  prompt: string;
  changes: string;
  iteration: number;
  accepted: boolean;
  caseEvaluations: CaseEvaluation[];
  averageTokenReduction: number;
  averageQualityScore: number;
  finalCompositeScore: number;
}

export interface HistoryLineInput {
  iteration: number;
  accepted: boolean;
  changes: string;
  averageTokenReduction: number;
  averageQualityScore: number;
  finalCompositeScore: number;
}

const DEFAULT_DATASET: DatasetCase[] = [
  {
    id: "ci-failure",
    userRequest: [
      "The worker bot merge button says CI is failing on PR #42 in agent-bridge.",
      "Tell me what happened and what to do next.",
      "Facts: repo agent-bridge, branch agent/work-17, failing command npm test -- test/prMergeGate.test.ts, error code 1.",
    ].join("\n"),
    expectedFacts: [
      "agent-bridge",
      "PR #42",
      "agent/work-17",
      "npm test -- test/prMergeGate.test.ts",
      "error code 1",
    ],
  },
  {
    id: "file-output",
    userRequest: [
      "Summarize the file output rule for Telegram delivery.",
      "Mention /tmp/bridge-out/codex--1004366290625 and say whether scratch files belong there.",
    ].join("\n"),
    expectedFacts: [
      "/tmp/bridge-out/codex--1004366290625",
      "only explicitly requested generated/shared files",
      "no scratchpad files",
      "bridge handles delivery",
    ],
  },
  {
    id: "memory-search",
    userRequest: [
      "Explain the bridge memory search limitation we found and the safest next implementation step.",
      "Keep it Telegram-short.",
    ].join("\n"),
    expectedFacts: [
      "project_memories_fts exists",
      "retrieval is lexical",
      "improve ranking/synonym expansion before vectors",
      "keep bridge-owned SQLite",
    ],
  },
  {
    id: "restart-safety",
    userRequest: [
      "I am inside an active bridge session. Should I run sudo systemctl restart agent-bridge-interactive from here?",
      "Give the direct answer and safe alternative.",
    ].join("\n"),
    expectedFacts: [
      "do not restart from active bot session",
      "systemd SIGTERM can kill current CLI process",
      "restart from outside active bot session",
      "/reset clears stale lock if needed",
    ],
  },
];

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function estimateTokenCount(text: string): number {
  const matches = String(text || "").match(/[A-Za-z0-9_./:-]+|[^\sA-Za-z0-9_./:-]/g);
  return matches?.length ?? 0;
}

export function calculateBrevityScore(optimizedCompletionTokens: number, baselineCompletionTokens: number): number {
  if (baselineCompletionTokens <= 0) return optimizedCompletionTokens <= 0 ? 1 : 0;
  return clamp01(1 - optimizedCompletionTokens / baselineCompletionTokens);
}

export function calculateCompositeScore(input: { brevityScore: number; qualityScore: number }): number {
  return clamp01(0.4 * input.brevityScore + 0.6 * input.qualityScore);
}

export function parseJsonObject<T extends object>(raw: string): T {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`LLM did not return JSON: ${raw.slice(0, 300)}`);
    return JSON.parse(match[0]) as T;
  }
}

export function parsePromptVariant(raw: string): { prompt: string; changes: string } {
  const parsed = parseJsonObject<{ prompt?: unknown; changes?: unknown }>(raw);
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  if (!prompt) throw new Error("Optimizer returned an empty prompt");

  let changes = "";
  if (typeof parsed.changes === "string") {
    changes = parsed.changes.trim();
  } else if (Array.isArray(parsed.changes)) {
    changes = parsed.changes.map((item) => String(item).trim()).filter(Boolean).join("; ");
  } else if (parsed.changes && typeof parsed.changes === "object") {
    changes = Object.entries(parsed.changes)
      .map(([key, value]) => `${key}: ${String(value).trim()}`)
      .join("; ");
  }

  return {
    prompt,
    changes: changes || "Optimizer returned prompt variant.",
  };
}

export function renderHistoryLine(input: HistoryLineInput): string {
  return [
    `Iteration ${input.iteration}`,
    `Decision: ${input.accepted ? "accepted" : "rejected"}`,
    `Prompt Changes Made: ${input.changes || "Initial candidate"}`,
    `Average Token Reduction %: ${(input.averageTokenReduction * 100).toFixed(1)}%`,
    `Average Quality Score: ${input.averageQualityScore.toFixed(3)}`,
    `Final Composite Score: ${input.finalCompositeScore.toFixed(3)}`,
  ].join("\n");
}

function buildSystemPrompt(styleBlock: string): string {
  return [
    styleBlock,
    "",
    "You are answering inside Telegram for an engineering operator.",
    "Preserve every critical technical fact from the user request.",
  ].join("\n");
}

function buildJudgeMessages(testCase: DatasetCase, baselineOutput: string, optimizedOutput: string): ModelMessage[] {
  return [
    { role: "system", content: JUDGE_SYSTEM_INSTRUCTIONS },
    {
      role: "user",
      content: JSON.stringify({
        userRequest: testCase.userRequest,
        expectedCriticalFacts: testCase.expectedFacts,
        baselineResponse: baselineOutput,
        optimizedResponse: optimizedOutput,
        rubric: {
          accuracy: "Retains all expected critical facts exactly enough to act on them.",
          styleCompliance: "Cuts throat-clearing, filler, vague corporate transitions, and needless framing.",
          tone: "Direct Telegram operational style.",
        },
      }, null, 2),
    },
  ];
}

function buildMutationMessages(best: PromptEvaluation, rejected: PromptEvaluation[], cases: CaseEvaluation[]): ModelMessage[] {
  const weakCases = [...cases].sort((a, b) => a.compositeScore - b.compositeScore).slice(0, 3);
  return [
    {
      role: "system",
      content: [
        "You optimize a TELEGRAM_RESPONSE_STYLE system prompt block for concise engineering replies.",
        "Return strict JSON with keys: prompt, changes.",
        "Keep the prompt block practical, not theatrical.",
        "Do not remove requirements to preserve file names, paths, commands, error codes, numeric values, and safety constraints.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Analyze stylistic failures or information losses that kept the score below 1.0.",
        "Tweak, rephrase, or add sharper constraints to maximize score.",
        "",
        `Current best score: ${best.finalCompositeScore.toFixed(3)}`,
        "Current best prompt:",
        best.prompt,
        "",
        "Weakest case evaluations:",
        JSON.stringify(weakCases, null, 2),
        "",
        "Rejected variants to avoid repeating:",
        JSON.stringify(rejected.map((r) => ({ changes: r.changes, score: r.finalCompositeScore })), null, 2),
      ].join("\n"),
    },
  ];
}

async function runDataset(styleBlock: string, dataset: DatasetCase[], client: LlmClient, model: string): Promise<CaseRun[]> {
  const system = buildSystemPrompt(styleBlock);
  const runs: CaseRun[] = [];
  for (const item of dataset) {
    const output = await client.complete([
      { role: "system", content: system },
      { role: "user", content: item.userRequest },
    ], { model, temperature: 0.2 });
    runs.push({ caseId: item.id, output, tokens: estimateTokenCount(output) });
  }
  return runs;
}

async function judgeCase(
  testCase: DatasetCase,
  baseline: CaseRun,
  optimized: CaseRun,
  client: LlmClient,
  model: string,
): Promise<CaseEvaluation> {
  const raw = await client.complete(buildJudgeMessages(testCase, baseline.output, optimized.output), {
    model,
    temperature: 0,
    jsonMode: true,
  });
  const parsed = parseJsonObject<{ score: number; rationale?: string }>(raw);
  const qualityScore = clamp01(Number(parsed.score));
  const brevityScore = calculateBrevityScore(optimized.tokens, baseline.tokens);
  return {
    caseId: testCase.id,
    baselineTokens: baseline.tokens,
    optimizedTokens: optimized.tokens,
    brevityScore,
    qualityScore,
    compositeScore: calculateCompositeScore({ brevityScore, qualityScore }),
    judgeRationale: parsed.rationale ?? "",
  };
}

async function evaluatePrompt(input: {
  prompt: string;
  changes: string;
  iteration: number;
  dataset: DatasetCase[];
  baselines: CaseRun[];
  client: LlmClient;
  generatorModel: string;
  judgeModel: string;
}): Promise<PromptEvaluation> {
  const optimizedRuns = await runDataset(input.prompt, input.dataset, input.client, input.generatorModel);
  const caseEvaluations: CaseEvaluation[] = [];
  for (const testCase of input.dataset) {
    const baseline = input.baselines.find((r) => r.caseId === testCase.id);
    const optimized = optimizedRuns.find((r) => r.caseId === testCase.id);
    if (!baseline || !optimized) throw new Error(`Missing run for case ${testCase.id}`);
    caseEvaluations.push(await judgeCase(testCase, baseline, optimized, input.client, input.judgeModel));
  }
  const averageTokenReduction = average(caseEvaluations.map((e) => e.brevityScore));
  const averageQualityScore = average(caseEvaluations.map((e) => e.qualityScore));
  const finalCompositeScore = average(caseEvaluations.map((e) => e.compositeScore));
  return {
    prompt: input.prompt,
    changes: input.changes,
    iteration: input.iteration,
    accepted: false,
    caseEvaluations,
    averageTokenReduction,
    averageQualityScore,
    finalCompositeScore,
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function mutatePrompt(best: PromptEvaluation, rejected: PromptEvaluation[], client: LlmClient, model: string): Promise<{ prompt: string; changes: string }> {
  const raw = await client.complete(buildMutationMessages(best, rejected, best.caseEvaluations), {
    model,
    temperature: 0.6,
    jsonMode: true,
  });
  return parsePromptVariant(raw);
}

export async function runOptimizationLoop(input: {
  dataset: DatasetCase[];
  client: LlmClient;
  generatorModel: string;
  judgeModel: string;
  optimizerModel: string;
  passes: number;
  log?: (line: string) => void;
}): Promise<{ best: PromptEvaluation; history: PromptEvaluation[] }> {
  const log = input.log ?? console.log;
  const baselines = await runDataset(LEGACY_TELEGRAM_RESPONSE_STYLE, input.dataset, input.client, input.generatorModel);
  const history: PromptEvaluation[] = [];
  const rejected: PromptEvaluation[] = [];

  let best = await evaluatePrompt({
    prompt: DRAFT_TELEGRAM_RESPONSE_STYLE,
    changes: "Initial draft from stop-slop/caveman spike.",
    iteration: 1,
    dataset: input.dataset,
    baselines,
    client: input.client,
    generatorModel: input.generatorModel,
    judgeModel: input.judgeModel,
  });
  best.accepted = true;
  history.push(best);
  log(renderHistoryLine(best));

  for (let pass = 0; pass < input.passes; pass += 1) {
    const iteration = pass + 2;
    const variant = await mutatePrompt(best, rejected, input.client, input.optimizerModel);
    const evaluated = await evaluatePrompt({
      prompt: variant.prompt,
      changes: variant.changes,
      iteration,
      dataset: input.dataset,
      baselines,
      client: input.client,
      generatorModel: input.generatorModel,
      judgeModel: input.judgeModel,
    });
    if (evaluated.finalCompositeScore > best.finalCompositeScore) {
      evaluated.accepted = true;
      best = evaluated;
    } else {
      evaluated.accepted = false;
      rejected.push(evaluated);
    }
    history.push(evaluated);
    log(renderHistoryLine(evaluated));
  }

  log([
    "Best Prompt",
    `Score: ${best.finalCompositeScore.toFixed(3)}`,
    best.prompt,
  ].join("\n"));
  return { best, history };
}

export function extractAgyResponse(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  let lastSepIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === "***") {
      lastSepIdx = i;
      break;
    }
  }
  if (lastSepIdx !== -1) {
    return lines.slice(lastSepIdx + 1).join("\n").trim();
  }
  return stdout.trim();
}

export function formatAgyPrompt(messages: ModelMessage[], jsonMode: boolean): string {
  const parts: string[] = [
    "You are being called by an automated prompt-optimization experiment.",
    "Respond to the final user task only.",
    "Do not run shell commands or edit files.",
  ];
  if (jsonMode) {
    parts.push("Return only strict JSON.");
  }
  parts.push("");
  for (const message of messages) {
    parts.push(`${message.role.toUpperCase()}:`);
    parts.push(message.content);
    parts.push("");
  }
  return parts.join("\n").trim() + "\n";
}

export class AgyPipeClient implements LlmClient {
  private command: string;
  private runner: AgyRunner;
  private timeoutMs: number;

  constructor(input: { command?: string; runner?: AgyRunner; timeoutMs?: number } = {}) {
    this.command = input.command || process.env.OPTIMIZER_AGY_COMMAND || "agy";
    this.runner = input.runner || runAgyProcess;
    this.timeoutMs = input.timeoutMs ?? Number(process.env.OPTIMIZER_AGY_TIMEOUT_MS || 600_000);
  }

  async complete(messages: ModelMessage[], options: { model: string; temperature?: number; jsonMode?: boolean }): Promise<string> {
    const prompt = formatAgyPrompt(messages, options.jsonMode === true);
    const timeoutSeconds = Math.ceil(this.timeoutMs / 1000);
    const args = ["--print-timeout", `${timeoutSeconds}s`, "--print", prompt];
    return this.runner(this.command, args, this.timeoutMs);
  }
}

function runAgyProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error(`agy optimizer call timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(extractAgyResponse(stdout));
        return;
      }
      reject(new Error(`agy optimizer call failed code=${code ?? "null"} signal=${signal ?? "none"}: ${(stderr || stdout).trim()}`));
    });
  });
}

export class CodexPipeClient implements LlmClient {
  private command: string;
  private runner: CodexRunner;
  private timeoutMs: number;

  constructor(input: { command?: string; runner?: CodexRunner; timeoutMs?: number } = {}) {
    this.command = input.command || process.env.OPTIMIZER_CODEX_COMMAND || "codex";
    this.runner = input.runner || runCodexProcess;
    this.timeoutMs = input.timeoutMs ?? Number(process.env.OPTIMIZER_CODEX_TIMEOUT_MS || 600_000);
  }

  async complete(messages: ModelMessage[], options: { model: string; temperature?: number; jsonMode?: boolean }): Promise<string> {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--model",
      options.model,
      "-",
    ];
    const prompt = formatCodexPipePrompt(messages, options.jsonMode === true);
    return this.runner(this.command, args, prompt, this.timeoutMs);
  }
}

export function formatCodexPipePrompt(messages: ModelMessage[], jsonMode: boolean): string {
  const parts: string[] = [
    "You are being called by an automated prompt-optimization experiment.",
    "Respond to the final user task only.",
    "Do not run shell commands or edit files.",
  ];
  if (jsonMode) {
    parts.push("Return only strict JSON.");
  }
  parts.push("");
  for (const message of messages) {
    parts.push(`${message.role.toUpperCase()}:`);
    parts.push(message.content);
    parts.push("");
  }
  return parts.join("\n").trim() + "\n";
}

function runCodexProcess(command: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error(`codex optimizer call timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`codex optimizer call failed code=${code ?? "null"} signal=${signal ?? "none"}: ${(stderr || stdout).trim()}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function loadDataset(path: string | null): DatasetCase[] {
  if (!path) return DEFAULT_DATASET;
  if (!existsSync(path)) throw new Error(`Dataset file not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as DatasetCase[];
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Dataset must be a non-empty array");
  for (const item of parsed) {
    if (!item.id || !item.userRequest || !Array.isArray(item.expectedFacts)) {
      throw new Error("Each dataset item needs id, userRequest, expectedFacts[]");
    }
  }
  return parsed;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const generatorModel = process.env.OPTIMIZER_GENERATOR_MODEL || process.env.OPTIMIZER_MODEL || "gpt-5.5";
  const judgeModel = process.env.OPTIMIZER_JUDGE_MODEL || process.env.OPTIMIZER_MODEL || generatorModel;
  const optimizerModel = process.env.OPTIMIZER_MODEL || generatorModel;
  const passes = Number(argValue("--passes") || process.env.OPTIMIZER_PASSES || 4);
  const dataset = loadDataset(argValue("--dataset"));
  const client = new AgyPipeClient();

  await runOptimizationLoop({
    dataset,
    client,
    generatorModel,
    judgeModel,
    optimizerModel,
    passes: Math.max(3, Math.min(5, passes)),
  });
}

function isMainEntry(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv).href;
  }
}

if (isMainEntry()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
