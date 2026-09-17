import { randomUUID } from "node:crypto";
import { nodeStdioStream, runAcpSessionSetup } from "../acp/index.js";
import { replaceAcpSessionConfigSnapshot, type AcpSessionConfigOptionSnapshot } from "../acp/sessionConfig.js";
import { runSupervisedStdioSession } from "../cliSupervisor.js";
import type { BotKind, CliOptions } from "../types.js";
import { getAcpProviderPolicy, providerIdForBotName } from "./registry.js";
import { resolveProviderRuntime } from "./acpRuntime.js";
import type { ProviderInvocationRequest } from "./types.js";

const CONFIG_DISCOVERY_TIMEOUT_MS = 15_000;

export interface AcpProviderConfigDiscoveryInput {
  readonly bot: BotKind;
  readonly cwd: string;
  readonly conversationId: string;
  readonly existingAcpSessionId: string | null;
  readonly executionMode: "safe" | "trusted";
  readonly env?: Record<string, string | undefined>;
}

export interface AcpProviderConfigDiscoveryResult {
  readonly sessionId: string;
  readonly configOptions: readonly AcpSessionConfigOptionSnapshot[];
}

/**
 * Bootstrap the provider-owned ACP session configuration catalogue without
 * sending a prompt. The provider child is supervised and torn down after the
 * setup exchange; only the durable ACP resume handle and config snapshot live on.
 */
export async function discoverAcpProviderConfig(
  input: AcpProviderConfigDiscoveryInput,
): Promise<AcpProviderConfigDiscoveryResult> {
  const providerId = providerIdForBotName(input.bot);
  if (!providerId) throw new Error(`Unknown provider bot: ${input.bot}`);
  const policy = getAcpProviderPolicy(providerId);
  if (!policy) throw new Error(`Provider ${providerId} does not use ACP session configuration`);

  const effectiveEnv = { ...process.env, ...(input.env ?? {}) };
  const runtime = resolveProviderRuntime(providerId, effectiveEnv);
  if (runtime.transport !== "acp-stdio") throw new Error(`Provider ${providerId} is not an ACP runtime`);
  policy.validateRuntime?.(runtime);

  const request: ProviderInvocationRequest = {
    prompt: "",
    sessionId: input.existingAcpSessionId,
    command: runtime.executable,
    model: null,
    executionMode: input.executionMode,
    outputFormat: null,
    soulContext: null,
    attachments: [],
    outputDir: null,
    effort: null,
    toolMode: "default",
  };
  const providerEnv = policy.buildChildEnv?.(request, effectiveEnv) ?? {};
  const sessionSettings = policy.sessionSettings?.(request, effectiveEnv);
  const contextEnv = { ...(input.env ?? {}), ...providerEnv } as Record<string, string>;
  const runId = `config-discovery:${randomUUID()}`;
  const options: CliOptions = {
    bot: input.bot,
    timeoutMs: CONFIG_DISCOVERY_TIMEOUT_MS,
    idleTimeoutMs: CONFIG_DISCOVERY_TIMEOUT_MS,
    contextEnv,
    chatId: runId,
  };

  const result = await runSupervisedStdioSession(
    runtime.executable,
    [...runtime.args],
    input.cwd,
    options,
    async (io) => runAcpSessionSetup({
      stream: nodeStdioStream(
        io.stdin as import("node:stream").Writable,
        io.stdout as import("node:stream").Readable,
      ),
      cwd: input.cwd,
      conversationId: input.conversationId,
      runId,
      existingAcpSessionId: input.existingAcpSessionId,
      executionMode: input.executionMode,
      sessionMeta: sessionSettings?.meta,
      sessionModeId: sessionSettings?.modeId,
      sessionConfig: sessionSettings?.config,
      authenticateMethodId: policy.authenticateMethodId?.(effectiveEnv),
      signal: io.signal,
    }),
  );

  replaceAcpSessionConfigSnapshot(input.bot, result.configOptions, result.staleSessionConfig);
  return { sessionId: result.acpSessionId, configOptions: result.configOptions };
}
