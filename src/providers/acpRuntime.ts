/** Provider-neutral ACP launch, lifecycle, presentation and result plumbing. */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ContentBlock, Usage } from "@agentclientprotocol/sdk";
import { nodeStdioStream, runAcpTurn } from "../acp/index.js";
import type { AcpRetainedEvent, AcpTurnResult } from "../acp/client.js";
import { isAbortRequested, runSupervisedStdioSession } from "../cliSupervisor.js";
import { cleanOutputDir } from "../fileOutput.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
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

/**
 * Bridge-owned differences that ACP/its Registry cannot decide. Straightforward
 * providers can omit every hook after identity/presentation and use defaults.
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

function npxArgs(entry: AcpRegistryAgentEntry): string[] {
  return [...(entry.distribution.npx?.args ?? [])];
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
  const executable = overrides.executable ?? policy.resolveExecutable?.(env);
  if (!executable) {
    throw new Error(`ACP provider ${policy.providerId} has no resolved executable`);
  }
  const args = overrides.args
    ? [...overrides.args]
    : policy.resolveArgs
      ? policy.resolveArgs(env, entry)
      : npxArgs(entry);
  return {
    providerId: policy.providerId,
    transport: "acp-stdio",
    executable,
    args,
    versionArgs: ["--version"],
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
      executable: resolveProviderExecutable(providerId, env),
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

export function buildAcpProviderInvocation(
  providerId: ProviderId,
  request: ProviderInvocationRequest,
  env: Record<string, string | undefined> = process.env,
): ProviderInvocation {
  const runtime = resolveProviderRuntime(providerId, env);
  if (runtime.transport !== "acp-stdio") {
    throw new Error(`Provider ${providerId} is not configured for ACP stdio`);
  }
  return {
    command: runtime.executable,
    args: [...runtime.args],
    nativeSessionMode: request.sessionId ? "resume" : "fresh",
    transport: "acp-stdio",
  };
}

function providerBotKind(providerId: ProviderId): BotKind {
  return providerId === "agy" ? "antigravity" : providerId;
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

function redactAcpTurnError(error: unknown, env: NodeJS.ProcessEnv): unknown {
  if (!(error instanceof Error)) return error;
  if (getProviderApiKeySecretValues(env).length === 0) return error;
  error.message = redactProviderApiKeySecrets(error.message, env);
  const data = (error as Error & { data?: unknown }).data;
  if (data && typeof data === "object") {
    const redacted = redactProviderApiKeySecrets(JSON.stringify(data), env);
    try {
      (error as Error & { data?: unknown }).data = JSON.parse(redacted);
    } catch {
      (error as Error & { data?: unknown }).data = { redacted: "unparseable after credential redaction" };
    }
  }
  return error;
}

function telemetryFromUsage(providerId: ProviderId, usage: Usage | undefined): RunTelemetry | undefined {
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
  providerId: ProviderId,
  result: AcpTurnResult,
  policy: AcpProviderPolicy | null = getAcpProviderPolicy(providerId),
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
  const runtime = resolveProviderRuntime(providerId, effectiveEnv);
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
        onEvent: answerPreview || (eventContext && onEvent)
          ? (event) => {
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
    throw redactAcpTurnError(error, redactionEnv);
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
