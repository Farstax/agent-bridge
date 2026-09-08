/**
 * PURPOSE: Parallel ACP-backed Codex runtime. Speaks ACP rather than parsing
 * Codex exec JSONL. The legacy `codexRuntime.ts` path remains selectable.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ContentBlock, Usage } from "@agentclientprotocol/sdk";
import { nodeStdioStream, runAcpTurn } from "../acp/index.js";
import type { AcpTurnResult } from "../acp/client.js";
import { runSupervisedStdioSession } from "../cliSupervisor.js";
import type { CliOptions, CliResult, RunTelemetry } from "../types.js";
import { isAbortRequested } from "../cliSupervisor.js";
import { appendOutputDirInstruction, wrapPromptContext } from "../promptWrapping.js";
import type { ProviderInvocation, ProviderInvocationRequest } from "./types.js";
import { resolveCodexAcpArgs, resolveCodexAcpCommand } from "./codexRuntimeSelection.js";
import {
  getProviderApiKeySecretValues,
  redactProviderApiKeySecrets,
} from "./apiKeyAuth.js";
import { createStreamingSecretRedactor } from "./streamingSecretRedactor.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function buildInvocation(request: ProviderInvocationRequest): ProviderInvocation {
  return {
    command: resolveCodexAcpCommand(),
    args: resolveCodexAcpArgs(),
    nativeSessionMode: request.sessionId ? "resume" : "fresh",
    transport: "acp-stdio",
  };
}

export function initialAgentMode(request: Pick<ProviderInvocationRequest, "executionMode" | "toolMode">): string {
  if (request.toolMode === "none") return "read-only";
  if (request.executionMode === "trusted") return "agent-full-access";
  return "agent";
}

export function codexAcpConfig(request: Pick<ProviderInvocationRequest, "model" | "effort">): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (request.model) config.model = request.model;
  if (request.effort) config.model_reasoning_effort = request.effort;
  return config;
}

/** Codex ACP reads CODEX_API_KEY only during authenticate({ methodId: "api-key" }). */
export function codexAcpChildAuthEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (env.CODEX_API_KEY?.trim() && !env.DEFAULT_AUTH_REQUEST?.trim()) {
    return { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }) };
  }
  return {};
}

function promptBlocks(request: ProviderInvocationRequest): ContentBlock[] {
  const wrapped = appendOutputDirInstruction(
    wrapPromptContext(request.prompt, request.soulContext, request.includeResponseContract),
    request.outputDir,
  );
  const blocks: ContentBlock[] = [{ type: "text", text: wrapped }];
  for (const path of request.attachments) {
    const mimeType = IMAGE_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    const data = readFileSync(path).toString("base64");
    blocks.push({ type: "image", data, mimeType, uri: `file://${path}` });
  }
  return blocks;
}

function telemetryFromUsage(usage: Usage | undefined): RunTelemetry | undefined {
  if (!usage) return undefined;
  return {
    provider: "codex",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.thoughtTokens != null ? { reasoningTokens: usage.thoughtTokens } : {}),
    ...(usage.cachedReadTokens != null ? { cachedInputTokens: usage.cachedReadTokens } : {}),
  };
}

export function toCliResult(result: AcpTurnResult): CliResult {
  if (!result.liveText.trim() && result.stopReason !== "cancelled") {
    throw new Error(`Codex ACP completed without live text (stopReason=${result.stopReason})`);
  }
  return {
    text: result.liveText.trim(),
    sessionId: result.acpSessionId,
    ...(telemetryFromUsage(result.usage) ? { telemetry: telemetryFromUsage(result.usage) } : {}),
  };
}

export async function runTurn(
  request: ProviderInvocationRequest,
  cwd: string,
  options: CliOptions,
  identities: { conversationId: string; runId: string },
): Promise<CliResult> {
  const invocation = buildInvocation(request);
  const config = codexAcpConfig(request);
  const contextEnv = {
    ...(options.contextEnv ?? {}),
    ...codexAcpChildAuthEnv({ ...process.env, ...(options.contextEnv ?? {}) }),
    INITIAL_AGENT_MODE: initialAgentMode(request),
    ...(Object.keys(config).length > 0 ? { CODEX_CONFIG: JSON.stringify(config) } : {}),
  };
  const chatId = options.chatId;
  const redactionEnv = { ...process.env, ...contextEnv };
  const liveRedactor = createStreamingSecretRedactor(getProviderApiKeySecretValues(redactionEnv));
  const result = await runSupervisedStdioSession(
    invocation.command,
    invocation.args,
    cwd,
    { ...options, contextEnv, bot: options.bot ?? "codex" },
    async (io) => runAcpTurn({
      stream: nodeStdioStream(io.stdin as import("node:stream").Writable, io.stdout as import("node:stream").Readable),
      cwd,
      conversationId: identities.conversationId,
      runId: identities.runId,
      existingAcpSessionId: request.sessionId,
      prompt: promptBlocks(request),
      executionMode: request.executionMode,
      abortRequested: () => chatId != null && isAbortRequested(chatId),
      signal: io.signal,
      onLiveText: options.onProgress
        ? (text) => {
          const safe = liveRedactor.push(text);
          if (safe) options.onProgress?.(safe);
        }
        : undefined,
    }),
  );
  const flushed = liveRedactor.flush();
  if (flushed) options.onProgress?.(flushed);
  const parsed = toCliResult(result);
  return {
    ...parsed,
    text: redactProviderApiKeySecrets(parsed.text, redactionEnv),
  };
}
