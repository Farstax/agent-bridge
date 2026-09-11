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
import * as grokRuntime from "./providers/grokRuntime.js";
import * as cursorRuntime from "./providers/cursorRuntime.js";
import * as antigravityRuntime from "./providers/antigravityRuntime.js";
import { extractAntigravityRunTelemetry } from "./providers/antigravityTelemetry.js";
import {
  extractAntigravityConversationId,
  toAntigravityModelLabel,
  ensureAntigravityStateDirs,
  setAntigravityModel,
  readAntigravityLastConversation,
  readLatestAntigravityConversationFromLogs,
  resolveAntigravityConversationId,
} from "./providers/antigravityRuntime.js";
import {
  runAntigravitySerialized,
  type AntigravityExecutionContext,
} from "./providers/antigravitySerializedRunner.js";

export {
  extractAntigravityConversationId,
  toAntigravityModelLabel,
  ensureAntigravityStateDirs,
  setAntigravityModel,
  readAntigravityLastConversation,
  readLatestAntigravityConversationFromLogs,
  resolveAntigravityConversationId,
};
import { appendEffortArgs, resolveAgyModelForEffort, type EffortLevel } from "./effort.js";
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
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  CliTimeoutError,
  resolveSupervisorTimeouts,
  isAbortRequested,
  isChildRunning,
} from "./cliSupervisor.js";
import { normalizeCliArgs } from "./cliArgNormalization.js";
import {
  captureParsedProviderOutput,
  consumePendingRunFallback,
  noteRunProviderAttempt,
  registerProviderOutput,
} from "./runTelemetry.js";
import { wrapPromptContext } from "./promptWrapping.js";
import {
  AntigravityUncertainCompletionError,
  CursorUncertainCompletionError,
  GrokUncertainCompletionError,
  isAntigravityUncertainCompletionFailureMessage,
  isCursorUncertainCompletionFailureMessage,
  isGrokUncertainCompletionFailureMessage,
} from "./cliSuccessfulExitValidation.js";
import { type as evtType } from "./events/types.js";
import { redactProviderApiKeySecrets } from "./providers/apiKeyAuth.js";

const antigravityInvocationMetadata = new WeakMap<string[], AntigravityExecutionContext>();

type RecoverableProvider = "antigravity" | "grok" | "cursor";

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
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  normalizeCliArgs,
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
  bot: string,
  prompt: string,
  sessionId: string | null,
  attachments: string[],
  includeResponseContract: boolean,
): string {
  if (includeResponseContract) return prompt;
  const startsFresh = !sessionId || (bot === "codex" && attachments.length > 0);
  if (startsFresh) return wrapPromptContext(prompt, null, false, true);
  return prompt.startsWith("/") ? `User request:\n${prompt}` : prompt;
}

/** Builds the CLI invocation for a bot. */
export function buildCliInvocation({
  bot,
  prompt,
  sessionId,
  sessionMode = "resume",
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
  nativeCompletion = false,
}: {
  bot: string;
  prompt: string;
  sessionId: string | null;
  sessionMode?: "resume" | "session-id";
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
  nativeCompletion?: boolean;
}): ProviderInvocation {
  void sessionMode;
  if (toolMode === "none" && !supportsToolFreeMode(bot)) {
    throw new Error(`Tool-free mode is not supported for ${bot}`);
  }

  const providerPrompt = seedFreshExecutionContract(bot, prompt, sessionId, attachments, includeResponseContract);
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
      nativeCompletion,
    });
  }
  if (bot === "grok") {
    return grokRuntime.buildInvocation({
      prompt: providerPrompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode, nativeCompletion,
    });
  }
  if (bot === "cursor") {
    return cursorRuntime.buildInvocation({
      prompt: providerPrompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode, nativeCompletion,
    });
  }
  if (bot === "antigravity") {
    const resolvedModel = resolveAgyModelForEffort(model, effort);
    const invocation = antigravityRuntime.buildInvocation({
      prompt: providerPrompt, sessionId, command, model: resolvedModel, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode, nativeCompletion, logFile, homeDir,
    });
    antigravityInvocationMetadata.set(invocation.args, {
      homeDir,
      model: resolvedModel,
      applyModel: true,
    });
    return invocation;
  }
  return { command, args: appendEffortArgs(command, [], effort), nativeSessionMode: "fresh" };
}

export { validateBridgeConfig } from "./config.js";
/** Backwards-compatible test/import alias; execution dispatch no longer depends on it. */
export { runTurn as runCodexAcpTurn } from "./providers/codexAcpRuntime.js";

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

/** Parses native CLI results. ACP-backed providers bypass this path. */
export function parseCliResult({
  bot,
  stdout,
  logContent = null,
  outputFormat = null,
}: {
  bot: string;
  stdout: string;
  logContent?: string | null;
  outputFormat?: "text" | "json" | "stream-json" | "streaming-json" | null;
}): CliResult {
  void logContent;
  let result: CliResult;
  const providerId = providerIdForBotName(bot);
  if (providerId && resolveProviderRuntime(providerId).transport === "acp-stdio") {
    throw new Error(`${bot} uses ACP structured results and is not parsed as native CLI output`);
  } else if (bot === "grok") {
    result = grokRuntime.parseResult(stdout);
  } else if (bot === "cursor") {
    result = cursorRuntime.parseResult(stdout);
  } else if (bot === "antigravity") {
    void outputFormat;
    result = antigravityRuntime.parseResult(stdout);
    const telemetry = extractAntigravityRunTelemetry(stdout);
    if (telemetry) result = { ...result, telemetry };
  } else {
    throw new Error(`Unknown bot type: ${bot}`);
  }
  captureParsedProviderOutput(bot, stdout, result.telemetry);
  return result;
}

function extractUpstreamCliError(raw: string): string | null {
  let turnFailed: string | null = null;
  let genericError: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const obj = JSON.parse(line.slice(start));
      if (obj?.type === "turn.failed" && typeof obj?.error?.message === "string") {
        turnFailed = obj.error.message;
      } else if (obj?.type === "error" && typeof obj?.message === "string") {
        genericError = obj.message;
      }
    } catch { /* not JSON, skip */ }
  }
  return turnFailed ?? genericError;
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

function isAntigravityExecution(options: CliOptions): boolean {
  return options.bot === "antigravity" || options.eventContext?.bot === "antigravity";
}

function eventChatKey(options: CliOptions): string | undefined {
  return options.eventContext?.chatKey;
}

function providerRecoveryPrompt(provider: RecoverableProvider): string {
  const name = provider === "antigravity" ? "Agy" : provider === "grok" ? "Grok" : "Cursor";
  return [
    "Agent Bridge detected that the immediately preceding turn ended with uncertain completion.",
    `Reconcile the current ${name} session state for that preceding user request.`,
    "Inspect what actually completed and return one final user-facing closure.",
    "Do not repeat side effects that already completed.",
    "Finish remaining safe work only when the current session state proves it is still required.",
    "If completion cannot be verified, state the concrete blocker or uncertainty.",
  ].join(" ");
}

function optionValue(args: string[], name: string): string | null {
  const index = args.lastIndexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function effortFromArgs(args: string[]): EffortLevel | null {
  const direct = optionValue(args, "--effort");
  if (direct === "low" || direct === "medium" || direct === "high" || direct === "xhigh" || direct === "max") {
    return direct;
  }
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c" && args[index] !== "--config") continue;
    const match = args[index + 1]?.match(/^model_reasoning_effort="?(low|medium|high|xhigh|max)"?$/);
    if (match) return match[1] as EffortLevel;
  }
  return null;
}

function safeRecoveryResult(options: CliOptions, result: CliResult): CliResult {
  return {
    ...result,
    text: redactProviderApiKeySecrets(result.text, { ...process.env, ...(options.contextEnv ?? {}) }),
  };
}

function serializeProviderResult(
  provider: RecoverableProvider,
  result: CliResult,
): string {
  if (provider === "antigravity") {
    return JSON.stringify({
      event: "result",
      result: { conversation_id: result.sessionId, status: "SUCCESS", response: result.text },
    }) + "\n";
  }
  if (provider === "grok") {
    return [
      JSON.stringify({ type: "text", data: result.text }),
      JSON.stringify({ type: "end", sessionId: result.sessionId, stopReason: "end_turn" }),
    ].join("\n") + "\n";
  }
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: result.text,
    session_id: result.sessionId,
  }) + "\n";
}

function incompleteProviderText(provider: RecoverableProvider): string {
  const name = provider === "antigravity" ? "Agy" : provider === "grok" ? "Grok" : "Cursor";
  return `${name} stopped before confirming completion. Some work may have been applied, but completion could not be verified.`;
}

function emitRecoveryCompleted(options: CliOptions, result: CliResult): void {
  if (!options.eventContext || !options.onEvent) return;
  try {
    options.onEvent(evtType.runCompleted({
      ...options.eventContext,
      text: result.text,
      sessionId: result.sessionId ?? null,
    }));
  } catch {
    /* event observation must not break recovered execution */
  }
}

function emitRecoveryFailed(options: CliOptions, message: string): void {
  if (!options.eventContext || !options.onEvent) return;
  try {
    options.onEvent(evtType.runFailed({
      ...options.eventContext,
      error: message,
      category: "cli",
    }));
  } catch {
    /* event observation must not break recovered execution */
  }
}

function recoveryWasCancelled(options: CliOptions): boolean {
  return options.chatId != null && isAbortRequested(options.chatId);
}

function finishRecoveryCancelled(options: CliOptions): { stdout: string } {
  if (options.eventContext && options.onEvent) {
    try {
      options.onEvent(evtType.runCancelled({
        ...options.eventContext,
        reason: "user",
      }));
    } catch {
      /* event observation must not break cancelled execution */
    }
  }
  return { stdout: "" };
}

type NonClaudeUncertainCompletionError =
  | AntigravityUncertainCompletionError
  | GrokUncertainCompletionError
  | CursorUncertainCompletionError;

function uncertainSessionId(error: NonClaudeUncertainCompletionError): string | null {
  return error.sessionId;
}

function originalSessionId(
  provider: RecoverableProvider,
  args: string[],
): string | null {
  if (provider === "antigravity") return optionValue(args, "--conversation");
  return optionValue(args, "--resume");
}

function providerExecutionMode(
  provider: RecoverableProvider,
  args: string[],
): "safe" | "trusted" {
  if (provider === "antigravity") return args.includes("--dangerously-skip-permissions") ? "trusted" : "safe";
  if (provider === "grok") return args.includes("--always-approve") ? "trusted" : "safe";
  return optionValue(args, "--sandbox") === "disabled" ? "trusted" : "safe";
}

function providerToolMode(
  provider: RecoverableProvider,
  args: string[],
): "default" | "none" {
  if (provider === "antigravity") return args.includes("--sandbox") ? "none" : "default";
  return "default";
}

function providerOutputFormat(
  provider: RecoverableProvider,
): ProviderInvocationRequest["outputFormat"] {
  if (provider === "cursor") return "stream-json";
  if (provider === "grok") return "streaming-json";
  return "stream-json";
}

function isRecoverableProvider(provider: string | undefined): provider is RecoverableProvider {
  return provider === "antigravity" || provider === "grok" || provider === "cursor";
}

function isNonClaudeUncertainCompletion(
  provider: RecoverableProvider,
  error: unknown,
): error is NonClaudeUncertainCompletionError {
  return (provider === "antigravity" && error instanceof AntigravityUncertainCompletionError)
    || (provider === "grok" && error instanceof GrokUncertainCompletionError)
    || (provider === "cursor" && error instanceof CursorUncertainCompletionError);
}

function isProviderUncertainCompletionFailureMessage(provider: string | undefined, message: string): boolean {
  if (provider === "antigravity") return isAntigravityUncertainCompletionFailureMessage(message);
  if (provider === "grok") return isGrokUncertainCompletionFailureMessage(message);
  if (provider === "cursor") return isCursorUncertainCompletionFailureMessage(message);
  return false;
}

async function recoverProviderUncertainCompletion(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions,
  provider: RecoverableProvider,
  error: NonClaudeUncertainCompletionError,
): Promise<{ stdout: string }> {
  const sessionId = uncertainSessionId(error) ?? originalSessionId(provider, args);
  const finishIncomplete = (): { stdout: string } => {
    const message = incompleteProviderText(provider);
    if (!sessionId) {
      emitRecoveryFailed(options, message);
      throw new Error(message);
    }
    const result = safeRecoveryResult(options, { text: message, sessionId });
    emitRecoveryCompleted(options, result);
    return { stdout: serializeProviderResult(provider, result) };
  };
  if (recoveryWasCancelled(options)) return finishRecoveryCancelled(options);
  if (!sessionId) return finishIncomplete();

  const agyMetadata = provider === "antigravity" ? antigravityInvocationMetadata.get(args) : undefined;
  const recoveryInvocation = buildCliInvocation({
    bot: provider,
    prompt: providerRecoveryPrompt(provider),
    sessionId,
    command,
    model: provider === "antigravity" ? agyMetadata?.model ?? null : optionValue(args, "--model"),
    executionMode: providerExecutionMode(provider, args),
    outputFormat: providerOutputFormat(provider),
    logFile: provider === "antigravity" ? optionValue(args, "--log-file") : null,
    soulContext: null,
    includeResponseContract: false,
    attachments: [],
    outputDir: null,
    effort: effortFromArgs(args),
    homeDir: provider === "antigravity" ? agyMetadata?.homeDir ?? homedir() : homedir(),
    toolMode: providerToolMode(provider, args),
    nativeCompletion: provider === "antigravity" && Boolean(optionValue(args, "--print")?.startsWith("/goal ")),
  });

  try {
    const recoveryOptions: CliOptions = {
      ...options,
      bot: provider,
      stdin: recoveryInvocation.stdin,
      eventContext: undefined,
      onEvent: undefined,
      onProviderOutputChunk: undefined,
    };
    const recovery = provider === "antigravity"
      ? await runAntigravitySerialized(
          recoveryInvocation.command,
          recoveryInvocation.args,
          cwd,
          recoveryOptions,
          antigravityInvocationMetadata.get(recoveryInvocation.args),
        )
      : await runSupervisedProcess(
          recoveryInvocation.command,
          recoveryInvocation.args,
          cwd,
          recoveryOptions,
        );
    if (recoveryWasCancelled(options)) return finishRecoveryCancelled(options);
    const parsed = parseCliResult({ bot: provider, stdout: recovery.stdout, outputFormat: providerOutputFormat(provider) });
    const result = safeRecoveryResult(options, parsed);
    emitRecoveryCompleted(options, result);
    return { stdout: serializeProviderResult(provider, result) };
  } catch {
    if (recoveryWasCancelled(options)) return finishRecoveryCancelled(options);
    return finishIncomplete();
  }
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
  const antigravityModel = isAntigravityExecution(options)
    ? antigravityInvocationMetadata.get(args)?.model ?? null
    : null;
  consumePendingRunFallback(options.eventContext?.runId, eventChatKey(options), provider);
  noteRunProviderAttempt(options.eventContext?.runId, provider, antigravityModel ?? explicitModel);

  const executionOptions: CliOptions = {
    ...options,
    processWatch: options.processWatch ?? getProcessWatchForCommand(command),
  };
  if (executionOptions.onEvent) {
    const onEvent = executionOptions.onEvent;
    executionOptions.onEvent = (event) => {
      if (event.type === "run.failed" && isProviderUncertainCompletionFailureMessage(provider, event.error)) return;
      onEvent(event);
    };
  }

  let outcome: { stdout: string };
  try {
    outcome = isAntigravityExecution(options)
      ? await runAntigravitySerialized(
          command,
          args,
          cwd,
          executionOptions,
          antigravityInvocationMetadata.get(args),
          onProgress,
        )
      : await runSupervisedProcess(command, args, cwd, executionOptions, onProgress);
  } catch (error) {
    if (isRecoverableProvider(provider) && isNonClaudeUncertainCompletion(provider, error)) {
      outcome = await recoverProviderUncertainCompletion(command, args, cwd, executionOptions, provider, error);
    } else {
      throw error;
    }
  }
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
