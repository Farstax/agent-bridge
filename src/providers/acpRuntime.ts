/** Provider-neutral ACP launch, lifecycle, presentation and result plumbing. */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ContentBlock, Usage } from "@agentclientprotocol/sdk";
import { nodeStdioStream, runAcpTurn } from "../acp/index.js";
import type { AcpRetainedEvent, AcpTurnResult } from "../acp/client.js";
import { isAbortRequested, runSupervisedStdioSession } from "../cliSupervisor.js";
import { cleanOutputDir } from "../fileOutput.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { RunActivity } from "../runActivity.js";
import type { BotKind, CliOptions, CliResult, RunTelemetry } from "../types.js";
import { type as bridgeEventType } from "../events/types.js";
import {
  getProviderApiKeySecretValues,
  redactProviderApiKeySecrets,
} from "./apiKeyAuth.js";
import { createStreamingSecretRedactor } from "./streamingSecretRedactor.js";
import type { ProviderId, ProviderInvocation, ProviderInvocationRequest } from "./types.js";
import type { AcpRegistryAgentEntry } from "./acpRegistry.js";
import { getLockedAcpRegistryEntry } from "./acpRegistry.js";
import {
  getAcpProviderPolicy,
  getProviderAdapter,
  providerIdForBotName,
  resolveProviderExecutable,
} from "./registry.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface AcpAnswerPreview {
  observe(event: AcpRetainedEvent): void;
  finish(stopReason: string): void;
}

export interface AcpActivityProjector {
  observe(event: AcpRetainedEvent): RunActivity | null;
}

/**
 * Bridge-owned differences that ACP/its Registry cannot decide. Straightforward
 * providers can omit every hook after identity/presentation and use Registry
 * distribution defaults.
 */
export interface AcpProviderPolicy {
  readonly providerId: string;
  readonly registryAgentId: string;
  readonly toolFree?: boolean;
  readonly presentation: {
    readonly provisionalAnswers: boolean;
    readonly createPreview?: (
      onAnswerDelta: (text: string) => void,
      secrets: readonly string[],
    ) => AcpAnswerPreview;
  };
  /** Optional installed-command resolver when Bridge does not invoke the Registry launcher directly. */
  readonly resolveExecutable?: (env: Record<string, string | undefined>) => string;
  readonly resolveArgs?: (
    env: Record<string, string | undefined>,
    entry: AcpRegistryAgentEntry,
  ) => string[];
  readonly buildChildEnv?: (
    request: ProviderInvocationRequest,
    env: Record<string, string | undefined>,
  ) => Record<string, string>;
  /** Runtime-affecting env keys that qualification must compare with the active process. */
  readonly qualificationEnvKeys?: readonly string[];
  /** Standard ACP authenticate method selected from workspace-local policy. */
  readonly authenticateMethodId?: (
    env: Record<string, string | undefined>,
  ) => string | undefined;
  /** Provider extension for structured run activity; generic ACP lifecycle remains here. */
  readonly createActivityProjector?: () => AcpActivityProjector;
  readonly selectAnswer?: (
    result: AcpTurnResult,
  ) => { text: string; missingDescription: string };
}

export interface ResolvedProviderRuntime {
  readonly providerId: string;
  readonly transport: "oneshot" | "acp-stdio";
  readonly executable: string;
  readonly args: readonly string[];
  readonly versionArgs: readonly string[];
  readonly runtimeIdentity: string;
  readonly selectedVersion: string | null;
  readonly registryAgentId: string | null;
  readonly distribution: AcpRegistryAgentEntry["distribution"] | null;
  readonly toolFree: boolean;
  readonly provisionalAnswers: boolean;
}

function distributionArgs(entry: AcpRegistryAgentEntry): string[] {
  if (entry.distribution.npx) return [...(entry.distribution.npx.args ?? [])];
  if (entry.distribution.uvx) return [...(entry.distribution.uvx.args ?? [])];
  return [];
}

function registryLaunch(entry: AcpRegistryAgentEntry): {
  executable: string;
  args: string[];
  versionArgs: string[];
} {
  if (entry.distribution.npx) {
    const packageSpec = entry.distribution.npx.package;
    return {
      executable: "npx",
      args: [packageSpec, ...(entry.distribution.npx.args ?? [])],
      versionArgs: [packageSpec, "--version"],
    };
  }
  if (entry.distribution.uvx) {
    const packageSpec = entry.distribution.uvx.package;
    return {
      executable: "uvx",
      args: [packageSpec, ...(entry.distribution.uvx.args ?? [])],
      versionArgs: [packageSpec, "--version"],
    };
  }
  throw new Error(
    `ACP Registry entry ${entry.id}@${entry.version} requires a managed binary install resolver`,
  );
}

export function resolveAcpProviderRuntime(
  policy: AcpProviderPolicy,
  entry: AcpRegistryAgentEntry,
  overrides: {
    env?: Record<string, string | undefined>;
    executable?: string;
    args?: readonly string[];
  } = {},
): ResolvedProviderRuntime {
  if (entry.id !== policy.registryAgentId) {
    throw new Error(
      `ACP registry lock mismatch for ${policy.providerId}: expected ${policy.registryAgentId}, got ${entry.id}`,
    );
  }
  const env = overrides.env ?? process.env;
  const directExecutable = overrides.executable ?? policy.resolveExecutable?.(env);
  const upstreamLaunch = directExecutable ? null : registryLaunch(entry);
  const executable = directExecutable ?? upstreamLaunch!.executable;
  const args = overrides.args
    ? [...overrides.args]
    : policy.resolveArgs
      ? policy.resolveArgs(env, entry)
      : directExecutable
        ? distributionArgs(entry)
        : upstreamLaunch!.args;
  const versionArgs = upstreamLaunch?.versionArgs ?? ["--version"];
  return {
    providerId: policy.providerId,
    transport: "acp-stdio",
    executable,
    args,
    versionArgs,
    runtimeIdentity: `acp:${entry.id}@${entry.version}`,
    selectedVersion: entry.version,
    registryAgentId: entry.id,
    distribution: entry.distribution,
    toolFree: policy.toolFree ?? false,
    provisionalAnswers: policy.presentation.provisionalAnswers,
  };
}

export function resolveProviderRuntime(
  providerId: ProviderId,
  env: Record<string, string | undefined> = process.env,
): ResolvedProviderRuntime {
  const policy = getAcpProviderPolicy(providerId);
  if (policy) {
    const entry = getLockedAcpRegistryEntry(providerId);
    if (!entry) throw new Error(`ACP provider ${providerId} has no release-locked registry entry`);
    return resolveAcpProviderRuntime(policy, entry, {
      env,
      ...(policy.resolveExecutable ? { executable: resolveProviderExecutable(providerId, env) } : {}),
    });
  }
  const adapter = getProviderAdapter(providerId);
  return {
    providerId,
    transport: "oneshot",
    executable: resolveProviderExecutable(providerId, env),
    args: adapter.defaultArgs,
    versionArgs: adapter.versionArgs,
    runtimeIdentity: `native:${providerId}`,
    selectedVersion: null,
    registryAgentId: null,
    distribution: null,
    toolFree: adapter.capabilities.toolFree,
    provisionalAnswers: false,
  };
}

/** Resolve a messaging/CLI-kind name through the runtime descriptor used by execution. */
export function resolveRuntimeForBotName(
  bot: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedProviderRuntime | null {
  const providerId = providerIdForBotName(bot);
  return providerId ? resolveProviderRuntime(providerId, env) : null;
}

export function supportsProvisionalAnswers(
  bot: string,
  env: Record<string, string | undefined> = process.env,
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): boolean {
  return resolveRuntime(bot, env)?.provisionalAnswers ?? false;
}

export function acpProviderIdForBotName(
  bot: string,
  env: Record<string, string | undefined> = process.env,
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): string | null {
  const runtime = resolveRuntime(bot, env);
  return runtime?.transport === "acp-stdio" ? runtime.providerId : null;
}

export function buildResolvedAcpProviderInvocation(
  runtime: ResolvedProviderRuntime,
  sessionId: string | null,
): ProviderInvocation {
  if (runtime.transport !== "acp-stdio") {
    throw new Error(`Provider ${runtime.providerId} is not configured for ACP stdio`);
  }
  return {
    command: runtime.executable,
    args: [...runtime.args],
    nativeSessionMode: sessionId ? "resume" : "fresh",
    transport: "acp-stdio",
  };
}

export function buildAcpProviderInvocation(
  providerId: ProviderId,
  request: ProviderInvocationRequest,
  env: Record<string, string | undefined> = process.env,
): ProviderInvocation {
  const runtime = resolveProviderRuntime(providerId, env);
  return buildResolvedAcpProviderInvocation(runtime, request.sessionId);
}

function providerBotKind(providerId: string): BotKind {
  return (providerId === "agy" ? "antigravity" : providerId) as BotKind;
}

function promptBlocks(request: ProviderInvocationRequest): ContentBlock[] {
  const wrapped = appendOutputDirInstruction(
    wrapPromptContext(request.prompt, request.soulContext, request.includeResponseContract),
    request.outputDir,
  );
  const blocks: ContentBlock[] = [{ type: "text", text: wrapped }];
  for (const path of request.attachments) {
    const mimeType = IMAGE_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    blocks.push({
      type: "image",
      data: readFileSync(path).toString("base64"),
      mimeType,
      uri: `file://${path}`,
    });
  }
  return blocks;
}

function redactAcpEventCredentials(event: AcpRetainedEvent, env: NodeJS.ProcessEnv): unknown {
  const secrets = getProviderApiKeySecretValues(env);
  if (secrets.length === 0) return event;
  const redacted = redactProviderApiKeySecrets(JSON.stringify(event), env);
  try {
    return JSON.parse(redacted);
  } catch {
    return { kind: event.kind, channel: event.channel, redacted: "unparseable after credential redaction" };
  }
}

function redactAcpFailureValue(
  value: unknown,
  env: NodeJS.ProcessEnv,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactProviderApiKeySecrets(value, env);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED_CIRCULAR_VALUE]";
  seen.add(value);
  if (value instanceof Error) {
    const source = value as Error & { cause?: unknown; [key: string]: unknown };
    const error = Object.create(Object.getPrototypeOf(value)) as Error & {
      cause?: unknown;
      [key: string]: unknown;
    };
    Object.defineProperty(error, "name", { value: value.name, writable: true, configurable: true });
    Object.defineProperty(error, "message", {
      value: redactProviderApiKeySecrets(value.message, env),
      writable: true,
      configurable: true,
    });
    if (value.stack) {
      Object.defineProperty(error, "stack", {
        value: redactProviderApiKeySecrets(value.stack, env),
        writable: true,
        configurable: true,
      });
    }
    if ("cause" in source) error.cause = redactAcpFailureValue(source.cause, env, seen);
    for (const key of Object.keys(source)) {
      if (key === "cause") continue;
      error[key] = redactAcpFailureValue(source[key], env, seen);
    }
    return error;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAcpFailureValue(item, env, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactAcpFailureValue(item, env, seen)]),
  );
}

/** Recursively remove provider secrets from Error and structured rejection shapes. */
export function redactAcpFailure(error: unknown, env: NodeJS.ProcessEnv): unknown {
  if (getProviderApiKeySecretValues(env).length === 0) return error;
  return redactAcpFailureValue(error, env, new WeakSet<object>());
}

function telemetryFromUsage(providerId: string, usage: Usage | undefined): RunTelemetry | undefined {
  if (!usage) return undefined;
  return {
    provider: providerBotKind(providerId),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.thoughtTokens != null ? { reasoningTokens: usage.thoughtTokens } : {}),
    ...(usage.cachedReadTokens != null ? { cachedInputTokens: usage.cachedReadTokens } : {}),
  };
}

export function acpTurnResultToCliResult(
  providerId: string,
  result: AcpTurnResult,
  policy: AcpProviderPolicy | null = null,
): CliResult {
  const selected = policy?.selectAnswer?.(result) ?? {
    text: result.liveText.trim(),
    missingDescription: "live text",
  };
  const text = selected.text.trim();
  if (!text && result.stopReason !== "cancelled") {
    throw new Error(
      `${providerId} ACP completed without ${selected.missingDescription} (stopReason=${result.stopReason})`,
    );
  }
  const telemetry = telemetryFromUsage(providerId, result.usage);
  return {
    text,
    sessionId: result.acpSessionId,
    stopReason: result.stopReason,
    ...(telemetry ? { telemetry } : {}),
  };
}

function createStandardAnswerPreview(
  onAnswerDelta: (text: string) => void,
  secrets: readonly string[],
): AcpAnswerPreview {
  const redactor = createStreamingSecretRedactor(secrets);
  return {
    observe(event): void {
      if (event.kind !== "session_update" || event.channel !== "live" || !event.notification) return;
      if (event.acpSessionId && event.notification.sessionId !== event.acpSessionId) return;
      const update = event.notification.update;
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
      const safe = redactor.push(update.content.text);
      if (safe) onAnswerDelta(safe);
    },
    finish(stopReason): void {
      if (stopReason === "cancelled") return;
      const safe = redactor.flush();
      if (safe) onAnswerDelta(safe);
    },
  };
}

export async function runResolvedAcpProviderTurn(
  policy: AcpProviderPolicy,
  runtime: ResolvedProviderRuntime,
  request: ProviderInvocationRequest,
  cwd: string,
  options: CliOptions,
  identities: { conversationId: string; runId: string },
): Promise<CliResult> {
  const providerId = runtime.providerId;
  if (policy.providerId !== providerId) {
    throw new Error(`ACP runtime/policy mismatch: ${providerId} != ${policy.providerId}`);
  }
  const effectiveEnv = { ...process.env, ...(options.contextEnv ?? {}) };
  if (runtime.transport !== "acp-stdio") throw new Error(`Provider ${providerId} is not an ACP runtime`);
  const providerEnv = policy.buildChildEnv?.(request, effectiveEnv) ?? {};
  const contextEnv = { ...(options.contextEnv ?? {}), ...providerEnv };
  const redactionEnv = { ...process.env, ...contextEnv };
  const secretValues = getProviderApiKeySecretValues(redactionEnv);
  const liveRedactor = createStreamingSecretRedactor(secretValues);
  const answerPreview = options.onAnswerDelta && runtime.provisionalAnswers
    ? (policy.presentation.createPreview?.(options.onAnswerDelta, secretValues)
      ?? createStandardAnswerPreview(options.onAnswerDelta, secretValues))
    : null;
  const activityProjector = options.onProgress?.activity && policy.createActivityProjector
    ? policy.createActivityProjector()
    : null;
  const chatId = options.chatId;
  const eventContext = options.eventContext;
  const onEvent = options.onEvent;
  let result: AcpTurnResult;
  try {
    result = await runSupervisedStdioSession(
      runtime.executable,
      [...runtime.args],
      cwd,
      { ...options, contextEnv, bot: options.bot ?? providerBotKind(providerId) },
      async (io) => runAcpTurn({
        stream: nodeStdioStream(
          io.stdin as import("node:stream").Writable,
          io.stdout as import("node:stream").Readable,
        ),
        cwd,
        conversationId: identities.conversationId,
        runId: identities.runId,
        existingAcpSessionId: request.sessionId,
        prompt: promptBlocks(request),
        executionMode: request.executionMode,
        authenticateMethodId: policy.authenticateMethodId?.(effectiveEnv),
        abortRequested: () => chatId != null && isAbortRequested(chatId),
        signal: io.signal,
        onLiveText: options.onProgress
          ? (text) => {
            const safe = liveRedactor.push(text);
            if (safe) options.onProgress?.(safe);
          }
          : undefined,
        onEvent: answerPreview || activityProjector || (eventContext && onEvent)
          ? (event) => {
            const runActivity = activityProjector?.observe(event);
            if (runActivity) options.onProgress?.activity?.(runActivity);
            answerPreview?.observe(event);
            if (!eventContext || !onEvent || !event.sessionMode) return;
            onEvent(bridgeEventType.acpEvent({
              runId: eventContext.runId,
              bot: eventContext.bot,
              chatId: eventContext.chatId,
              chatKey: eventContext.chatKey,
              threadId: eventContext.threadId,
              sessionId: event.acpSessionId ?? null,
              sessionMode: event.sessionMode,
              event: redactAcpEventCredentials(event, redactionEnv),
            }));
          }
          : undefined,
      }),
    );
  } catch (error) {
    throw redactAcpFailure(error, redactionEnv);
  }
  const flushed = liveRedactor.flush();
  if (flushed) options.onProgress?.(flushed);
  answerPreview?.finish(result.stopReason);
  const parsed = acpTurnResultToCliResult(providerId, result, policy);
  if (parsed.stopReason === "cancelled" && request.outputDir) {
    try {
      await cleanOutputDir(request.outputDir);
    } catch (error) {
      console.warn(`[${providerId}] failed to clean output after ACP provider cancellation`, error);
    }
  }
  return {
    ...parsed,
    text: redactProviderApiKeySecrets(parsed.text, redactionEnv),
  };
}

export async function runAcpProviderTurn(
  providerId: ProviderId,
  request: ProviderInvocationRequest,
  cwd: string,
  options: CliOptions,
  identities: { conversationId: string; runId: string },
): Promise<CliResult> {
  const policy = getAcpProviderPolicy(providerId);
  if (!policy) throw new Error(`Provider ${providerId} has no ACP runtime policy`);
  const effectiveEnv = { ...process.env, ...(options.contextEnv ?? {}) };
  return runResolvedAcpProviderTurn(
    policy,
    resolveProviderRuntime(providerId, effectiveEnv),
    request,
    cwd,
    options,
    identities,
  );
}
