import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type { BridgeDb, ExecutionLaneHandle } from "../db.js";
import { BridgeEngine, type SurfaceNeutralTurnInput } from "../engine.js";
import { EventStore } from "../events/store.js";
import { type as eventType, type BridgeEvent, type RunCompletedEvent } from "../events/types.js";
import { SAFE_SURFACE_CAPABILITIES, type MessagingPlatform } from "../platform.js";
import { loadBotsConfig, resolveExecutionMode } from "../config.js";
import { interactiveChainKinds, parseCliChain } from "../providers/selection.js";
import { lookupProviderSession, persistProviderSession } from "../providers/sessionRuntime.js";
import type { BotKind, BridgeConfig, CliResult } from "../types.js";
import type { OutwardAcpSessionRecord } from "../repositories/outwardAcpSessionRepository.js";

export const OUTWARD_ACP_SURFACE = "acp:outward";
const OUTWARD_ACP_EXECUTION_ERROR = -32001;
const OUTWARD_ACP_BUSY_ERROR = -32002;

type OutwardUpdate = acp.SessionNotification["update"];

export interface OutwardAcpPromptExecutionInput {
  session: OutwardAcpSessionRecord;
  prompt: string;
  onUpdate: (update: OutwardUpdate) => void | Promise<void>;
}

export interface OutwardAcpPromptExecutor {
  execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse>;
}

export type OutwardAcpExecutionEngine = Pick<BridgeEngine, "executeSurfaceNeutralTurn">;

export interface BridgeOutwardAcpPromptExecutorOptions {
  db: BridgeDb;
  provider: BotKind;
  createEngine: (session: OutwardAcpSessionRecord) => OutwardAcpExecutionEngine;
  runId?: () => string;
}

type RetainedSessionUpdate = {
  kind?: unknown;
  acpSessionId?: unknown;
  notification?: {
    sessionId?: unknown;
    update?: unknown;
  };
};

function rootProviderUpdate(event: BridgeEvent): OutwardUpdate | null {
  if (event.type !== "acp.event" || !event.event || typeof event.event !== "object") return null;
  const retained = event.event as RetainedSessionUpdate;
  if (retained.kind !== "session_update") return null;
  if (typeof retained.acpSessionId !== "string" || !retained.notification) return null;
  if (retained.notification.sessionId !== retained.acpSessionId) return null;
  if (!retained.notification.update || typeof retained.notification.update !== "object") return null;
  return retained.notification.update as OutwardUpdate;
}

function isAgentMessageChunk(update: OutwardUpdate): boolean {
  return update.sessionUpdate === "agent_message_chunk";
}

function normalizeStopReason(value: string | undefined): acp.StopReason {
  switch (value) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return value;
    default:
      return "end_turn";
  }
}

function failedEvent(
  runId: string,
  provider: BotKind,
  session: OutwardAcpSessionRecord,
  lane: ExecutionLaneHandle,
): BridgeEvent {
  return eventType.runFailed({
    runId,
    bot: provider,
    chatId: session.sessionId,
    chatKey: session.conversationId,
    error: "outward ACP prompt execution failed",
    category: "unknown",
    serviceId: lane.serviceId,
    acquisitionId: lane.acquisitionId,
  } as Parameters<typeof eventType.runFailed>[0]);
}

export class BridgeOutwardAcpPromptExecutor implements OutwardAcpPromptExecutor {
  constructor(private readonly options: BridgeOutwardAcpPromptExecutorOptions) {}

  async execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse> {
    const { db, provider } = this.options;
    const lane = db.acquireLock(OUTWARD_ACP_SURFACE, input.session.conversationId);
    if (!lane) {
      throw new acp.RequestError(
        OUTWARD_ACP_BUSY_ERROR,
        "outward ACP session is busy",
        { sessionId: input.session.sessionId },
      );
    }

    const runId = this.options.runId?.() ?? randomUUID();
    db.insertRun(runId, input.session.conversationId, provider);
    const eventStore = new EventStore(db, runId);
    const pendingUpdates: Promise<void>[] = [];
    let completed: RunCompletedEvent | null = null;
    let streamedAnswer = false;
    const collect = (event: BridgeEvent): void => {
      if (event.type === "run.completed") completed = event;
      else eventStore.collect(event);
      const update = rootProviderUpdate(event);
      if (!update) return;
      streamedAnswer ||= isAgentMessageChunk(update);
      pendingUpdates.push(Promise.resolve(input.onUpdate(update)));
    };

    const eventContext: NonNullable<SurfaceNeutralTurnInput["eventContext"]> = {
      runId,
      bot: provider,
      chatId: input.session.sessionId,
      chatKey: input.session.conversationId,
      threadId: undefined,
      serviceId: lane.serviceId,
      acquisitionId: lane.acquisitionId,
    };

    try {
      const providerSessionId = lookupProviderSession(db, input.session.conversationId, provider);
      const result: CliResult = await this.options.createEngine(input.session).executeSurfaceNeutralTurn({
        prompt: input.prompt,
        sessionId: providerSessionId,
        chatId: input.session.sessionId,
        chatKey: input.session.conversationId,
        laneHandle: lane,
        runId,
        eventContext,
        collect,
      });

      db.runWithLockFence(lane, () => {
        persistProviderSession(db, input.session.conversationId, provider, result.sessionId, runId);
      });

      if (!streamedAnswer && result.text) {
        pendingUpdates.push(Promise.resolve(input.onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text },
        })));
      }
      await Promise.all(pendingUpdates);

      if (completed) {
        eventStore.queueCompleted(completed);
      } else if (result.stopReason !== "cancelled") {
        eventStore.queueCompleted(eventType.runCompleted({
          runId,
          bot: provider,
          chatId: input.session.sessionId,
          chatKey: input.session.conversationId,
          text: result.text,
          sessionId: result.sessionId,
          ...(result.telemetry ? { telemetry: result.telemetry } : {}),
        }));
      }
      eventStore.finalize();
      return { stopReason: normalizeStopReason(result.stopReason) };
    } catch (error) {
      if (db.getRun(runId)?.status === "running") {
        eventStore.collect(failedEvent(runId, provider, input.session, lane));
        eventStore.finalize();
      }
      if (error instanceof acp.RequestError) throw error;
      throw new acp.RequestError(
        OUTWARD_ACP_EXECUTION_ERROR,
        "outward ACP prompt execution failed",
        { sessionId: input.session.sessionId, runId },
      );
    } finally {
      db.unlock(lane);
    }
  }
}

const NO_DELIVERY_PLATFORM: MessagingPlatform = {
  capabilities: SAFE_SURFACE_CAPABILITIES,
  async sendMessage() { return {}; },
  async editMessageText() { return {}; },
  async sendChatAction() { return {}; },
  async answerCallbackQuery() { return {}; },
  async setMyCommands() { return {}; },
  async sendDocument() {},
  async sendPhoto() {},
};

function configuredProvider(env: NodeJS.ProcessEnv): BotKind {
  const allowed = interactiveChainKinds() as BotKind[];
  const locked = env.BRIDGE_PROVIDER_LOCK?.trim() as BotKind | undefined;
  if (locked && allowed.includes(locked)) return locked;
  const fallback = (["codex", "claude", "grok", "antigravity", "cursor"] as BotKind[])
    .filter((kind) => allowed.includes(kind));
  const chain = parseCliChain(env.INTERACTIVE_CLI_CHAIN, { allowed, fallback });
  const provider = chain[0];
  if (!provider) throw new Error("no interactive provider is configured for outward ACP");
  return provider;
}

export function createProductionOutwardAcpPromptExecutor(
  db: BridgeDb,
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): BridgeOutwardAcpPromptExecutor {
  const provider = configuredProvider(env);
  const bots = loadBotsConfig(env);
  const allowedUserIds = new Set<string>();
  const executionMode = resolveExecutionMode(provider, env);
  const fullConfig: BridgeConfig = {
    allowedUserIds,
    serviceEnvFile: env.BRIDGE_ENV_FILE ?? null,
    serviceKind: provider,
    pollIntervalMs: 1000,
    executionMode,
    dbPath,
    bots,
  };
  return new BridgeOutwardAcpPromptExecutor({
    db,
    provider,
    createEngine: (session) => new BridgeEngine({
      kind: provider,
      surfaceIdentity: OUTWARD_ACP_SURFACE,
      executionKind: provider,
      botConfig: bots[provider],
      allowedUserIds,
      executionMode,
      pollIntervalMs: 1000,
      workingDir: session.cwd,
      fullConfig,
    }, db, NO_DELIVERY_PLATFORM),
  });
}
