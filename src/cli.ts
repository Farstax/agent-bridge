/**
 * PURPOSE: Child process management, CLI invocation builder, and execution response parsers for different bot CLI kinds.
 * INPUTS: Prompts, session IDs, model types, execution modes, and raw stdout/log file contents.
 * OUTPUTS: Spawned subprocess lifecycles, structured CLI command definitions, and parsed agent text responses and session IDs.
 * NEIGHBORS: src/index.ts, src/timeouts.ts
 * LOGIC: Spawns platform-specific CLI shells, applies strict timeouts, processes stdout streams with regex to isolate message content, and parses logs for session IDs.
 */

import { homedir } from "node:os";
import type { CliOptions, CliResult, BotKind } from "./types.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./providers/types.js";
import { randomUUID } from "node:crypto";
import { resolveTimeoutsForKind } from "./timeouts.js";
import {
  buildAcpProviderInvocation,
  resolveProviderRuntime,
  runAcpProviderTurn,
} from "./providers/acpRuntime.js";
import { appendEffortArgs, type EffortLevel } from "./effort.js";
import { isProviderFallbackEligibleError } from "./providers/fallbackEligibility.js";
import {
  getProcessWatchForCommand,
  providerIdForBotName,
  supportsToolFreeMode,
} from "./providers/registry.js";
import {
  runSupervisedProcess,
  runSupervisedStdioSession,
  getExecutionProcessState,
  buildSafeChildEnv,
  buildAdvisorChildEnv,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  abortCliProcess,
  abortCliProcessAndWait,
  abortExecutionAndWait,
  getActiveLaneHandle,
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  CliTimeoutError,
  resolveSupervisorTimeouts,
  isAbortRequested,
  isChildRunning,
} from "./cliSupervisor.js";
import {
  consumePendingRunFallback,
  noteRunProviderAttempt,
  registerProviderOutput,
} from "./runTelemetry.js";
import { wrapPromptContext } from "./promptWrapping.js";

export {
  getExecutionProcessState,
  runSupervisedStdioSession,
  buildSafeChildEnv,
  buildAdvisorChildEnv,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  abortCliProcess,
  abortCliProcessAndWait,
  abortExecutionAndWait,
  getActiveLaneHandle,
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  CliTimeoutError,
  resolveSupervisorTimeouts,
  isAbortRequested,
  isChildRunning,
  runAcpProviderTurn,
};

export function scrubOutputDir(text: string, outDir: string | null | undefined): string {
  if (!outDir) return text;
  const lines = text.split("\n");
  const filtered = lines.filter((line) => !line.includes(outDir));
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function seedFreshExecutionContract(
  prompt: string,
  sessionId: string | null,
  includeResponseContract: boolean,
): string {
  if (includeResponseContract) return prompt;
  if (!sessionId) return wrapPromptContext(prompt, null, false, true);
  return prompt.startsWith("/") ? `User request:\n${prompt}` : prompt;
}

/** Builds the CLI invocation for a bot. */
export function buildCliInvocation({
  bot,
  prompt,
  sessionId,
  command,
  model,
  executionMode = "safe",
  outputFormat = null,
  logFile = null,
  soulContext = null,
  includeResponseContract = true,
  attachments = [],
  outputDir = null,
  effort = null,
  homeDir = homedir(),
  toolMode = "default",
}: {
  bot: string;
  prompt: string;
  sessionId: string | null;
  command: string;
  model: string | null;
  executionMode?: "safe" | "trusted";
  outputFormat?: ProviderInvocationRequest["outputFormat"];
  logFile?: string | null;
  soulContext?: string | null;
  includeResponseContract?: boolean;
  attachments?: string[];
  outputDir?: string | null;
  effort?: EffortLevel | null;
  homeDir?: string;
  toolMode?: "default" | "none";
}): ProviderInvocation {
  if (toolMode === "none" && !supportsToolFreeMode(bot)) {
    throw new Error(`Tool-free mode is not supported for ${bot}`);
  }

  const providerPrompt = seedFreshExecutionContract(prompt, sessionId, includeResponseContract);
  const providerId = providerIdForBotName(bot);
  if (providerId && resolveProviderRuntime(providerId).transport === "acp-stdio") {
    return buildAcpProviderInvocation(providerId, {
      prompt: providerPrompt,
      sessionId,
      command,
      model,
      executionMode,
      outputFormat,
      soulContext,
      includeResponseContract,
      attachments,
      outputDir,
      effort,
      toolMode,
    });
  }
  return { command, args: appendEffortArgs(command, [], effort), nativeSessionMode: "fresh" };
}

export { validateBridgeConfig } from "./config.js";

/** Run a built invocation on the matching transport. ACP stdio is never oneshot-parsed. */
export async function runProviderInvocation(
  bot: string,
  invocation: ProviderInvocation,
  cwd: string,
  options: CliOptions,
  request: ProviderInvocationRequest,
  identities: { conversationId: string; runId: string } = {
    conversationId: String(options.chatId ?? "bridge"),
    runId: options.eventContext?.runId ?? randomUUID(),
  },
): Promise<CliResult> {
  if (invocation.transport === "acp-stdio") {
    const providerId = providerIdForBotName(bot);
    if (!providerId) throw new Error(`Unknown ACP provider: ${bot}`);
    return runAcpProviderTurn(providerId, request, cwd, {
      ...options,
      bot: (options.bot ?? bot) as BotKind,
    }, identities);
  }
  const { stdout } = await runConfiguredCli(invocation.command, invocation.args, cwd, {
    ...options,
    stdin: invocation.stdin ?? options.stdin,
  });
  return parseCliResult({
    bot,
    stdout,
    outputFormat: request.outputFormat === "stream-json" || request.outputFormat === "streaming-json" || request.outputFormat === "json"
      ? request.outputFormat
      : undefined,
  });
}

/** Resolve CLI execution options for a specific bot kind. */
export function buildExecutionOptions(kind: BotKind): CliOptions {
  const t = resolveTimeoutsForKind(kind);
  return {
    timeoutMs: t.cliTimeoutMs,
    idleTimeoutMs: t.cliIdleTimeoutMs,
    bot: kind,
  };
}

/**
 * Every provider is ACP-backed now; there is no remaining native CLI result
 * format to parse. Kept as a fail-closed entry point (rather than deleted
 * outright) since callers still branch on `parsedAcp ?? parseCliResult(...)`
 * as a defensive fallback for a transport that can no longer occur.
 */
export function parseCliResult({
  bot,
}: {
  bot: string;
  stdout: string;
  logContent?: string | null;
  outputFormat?: "text" | "json" | "stream-json" | "streaming-json" | null;
}): CliResult {
  const providerId = providerIdForBotName(bot);
  if (providerId) {
    throw new Error(`${bot} uses ACP structured results and is not parsed as native CLI output`);
  }
  throw new Error(`Unknown bot type: ${bot}`);
}

function extractUpstreamCliError(raw: string): string | null {
  let turnFailed: string | null = null;
  let resultError: string | null = null;
  let genericError: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const obj = JSON.parse(line.slice(start));
      if (obj?.type === "turn.failed" && typeof obj?.error?.message === "string") {
        turnFailed = obj.error.message;
      } else if (obj?.type === "result" && obj?.is_error === true && typeof obj?.result === "string") {
        resultError = obj.result;
      } else if (obj?.type === "error" && typeof obj?.message === "string") {
        genericError = obj.message;
      }
    } catch { /* not JSON, skip */ }
  }
  return turnFailed ?? resultError ?? genericError;
}

export function toUserMessage(err: Error): string {
  const upstream = extractUpstreamCliError(err.message);
  if (upstream) return upstream.trim();
  return err.message.split(":")[0].trim();
}

export function isCapacityExhaustedError(err: Error): boolean {
  return isProviderFallbackEligibleError(err);
}

export function getNextFallbackModel(currentModel: string | null, modelPreference: string[]): string | null {
  if (!currentModel || modelPreference.length <= 1) return null;
  const idx = modelPreference.indexOf(currentModel);
  if (idx === -1 || idx >= modelPreference.length - 1) return null;
  return modelPreference[idx + 1];
}

function eventChatKey(options: CliOptions): string | undefined {
  return options.eventContext?.chatKey;
}

async function runConfiguredCli(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions,
  onProgress?: (text: string) => void,
): Promise<{ stdout: string }> {
  const provider = options.eventContext?.bot ?? options.bot;
  const explicitModelIndex = args.lastIndexOf("--model");
  const explicitModel = explicitModelIndex >= 0 && explicitModelIndex + 1 < args.length
    ? args[explicitModelIndex + 1]
    : null;
  consumePendingRunFallback(options.eventContext?.runId, eventChatKey(options), provider);
  noteRunProviderAttempt(options.eventContext?.runId, provider, explicitModel);

  const executionOptions: CliOptions = {
    ...options,
    processWatch: options.processWatch ?? getProcessWatchForCommand(command),
  };

  const outcome = await runSupervisedProcess(command, args, cwd, executionOptions, onProgress);
  registerProviderOutput(options.eventContext?.runId, provider, outcome.stdout);
  return outcome;
}

/** Runs a CLI command and returns stdout. */
export async function runCli(command: string, args: string[], cwd: string, options: CliOptions = {}): Promise<string> {
  const { stdout } = await runConfiguredCli(command, args, cwd, options);
  return stdout;
}

/** Runs a CLI command asynchronously with progress support. */
export async function runCliAsync(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions = {},
): Promise<{ text: string }> {
  const { stdout } = await runConfiguredCli(command, args, cwd, options, options.onProgress);
  return { text: stdout };
}
