import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentApp,
  ClientContext,
  ContentBlock,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
  Stream,
  Usage,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { bridgeInitializeRequest } from "./capabilities.js";
import { mapAcpPermissionRequest } from "./permissions.js";
import { AcpReplayGate, liveDeliveryText, type AcpObservedUpdate } from "./replay.js";

export type AcpSessionMode = "fresh" | "load" | "resume";

export interface AcpRetainedEvent {
  readonly kind: "session_update" | "permission" | "stop";
  readonly channel: "replay" | "live";
  readonly notification?: SessionNotification;
  readonly stopReason?: StopReason;
  /** What the agent asked for and what Bridge decided, not merely that a permission event happened. */
  readonly permissionRequest?: RequestPermissionRequest;
  readonly permissionResponse?: RequestPermissionResponse;
  /** The parent/root ACP session for this Bridge turn, and how that session was entered. */
  readonly acpSessionId?: string;
  readonly sessionMode?: AcpSessionMode;
}

export interface AcpTurnInput {
  readonly cwd: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly existingAcpSessionId: string | null;
  readonly prompt: string | ContentBlock | ContentBlock[];
  readonly executionMode: "safe" | "trusted";
  /** Standard ACP authentication method selected by provider/workspace policy. */
  readonly authenticateMethodId?: string;
  readonly abortRequested?: () => boolean;
  readonly signal?: AbortSignal;
  readonly stream?: Stream;
  readonly peer?: AgentApp;
  readonly onLiveText?: (text: string) => void;
  readonly onEvent?: (event: AcpRetainedEvent) => void;
}

/** ACP v1 context-window usage: tokens currently in context vs the window size. Not per-turn consumption. */
export interface AcpContextUsage {
  readonly used: number;
  readonly size: number;
}

export interface AcpTurnResult {
  readonly conversationId: string;
  readonly runId: string;
  readonly acpSessionId: string;
  readonly sessionMode: AcpSessionMode;
  readonly stopReason: StopReason;
  readonly liveText: string;
  readonly events: readonly AcpRetainedEvent[];
  readonly updates: readonly AcpObservedUpdate[];
  /** Actual turn/prompt token consumption, only when the agent supplies PromptResponse.usage. */
  readonly usage?: Usage;
  readonly contextUsage?: AcpContextUsage;
  readonly initialize: InitializeResponse;
}

function promptBlocks(prompt: AcpTurnInput["prompt"]): ContentBlock[] {
  if (typeof prompt === "string") return [{ type: "text", text: prompt }];
  return Array.isArray(prompt) ? prompt : [prompt];
}

function agentSupportsResume(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.sessionCapabilities?.resume);
}

function agentSupportsLoad(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.loadSession);
}

/**
 * Text is always baseline-supported. Every other ContentBlock type is
 * gated by the agent's negotiated promptCapabilities (InitializeResponse) —
 * fail closed with a precise error before dispatch rather than silently
 * dropping an attachment the agent never agreed to accept.
 */
function assertPromptCapabilities(blocks: readonly ContentBlock[], init: InitializeResponse): void {
  const caps = init.agentCapabilities?.promptCapabilities;
  for (const block of blocks) {
    if (block.type === "text") continue;
    if (block.type === "image" && caps?.image) continue;
    if (block.type === "audio" && caps?.audio) continue;
    if (block.type === "resource" && caps?.embeddedContext) continue;
    throw new Error(
      `ACP agent does not support prompt content block type "${block.type}" `
      + `(negotiated promptCapabilities: ${JSON.stringify(caps ?? {})})`,
    );
  }
}

/** Actual turn consumption comes only from PromptResponse.usage; usage_update never fabricates it. */
function usageFrom(response: PromptResponse): Usage | undefined {
  return response.usage ?? undefined;
}

/** ACP v1 usage_update.used/size describe context-window occupancy, not per-turn consumption. */
function contextUsageFrom(
  updates: readonly AcpObservedUpdate[],
  sessionId: string,
): AcpContextUsage | undefined {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const observed = updates[i];
    if (observed.notification.sessionId !== sessionId) continue;
    const update = observed.notification.update;
    if (update.sessionUpdate === "usage_update") {
      return { used: update.used, size: update.size };
    }
  }
  return undefined;
}

export function nodeStdioStream(stdin: Writable, stdout: Readable): Stream {
  return acp.ndJsonStream(
    Writable.toWeb(stdin),
    Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
  );
}

export async function runAcpTurn(input: AcpTurnInput): Promise<AcpTurnResult> {
  if (!input.stream && !input.peer) {
    throw new Error("ACP turn requires a stdio stream or in-process agent");
  }
  if (input.existingAcpSessionId && input.existingAcpSessionId === input.conversationId) {
    throw new Error("ACP session id must not equal the Bridge conversation id");
  }

  const gate = new AcpReplayGate();
  const updates: AcpObservedUpdate[] = [];
  const events: AcpRetainedEvent[] = [];
  let liveEmitted = "";
  // Set by execute() before any notification/permission request can arrive
  // for the corresponding parent session, so remember() can tag child events
  // with their owning root turn while notification.sessionId remains the
  // actual root/child protocol session id.
  let currentAcpSessionId: string | undefined;
  let currentSessionMode: AcpSessionMode | undefined;

  const remember = (event: AcpRetainedEvent) => {
    const tagged: AcpRetainedEvent = {
      ...event,
      ...(currentAcpSessionId ? { acpSessionId: currentAcpSessionId } : {}),
      ...(currentSessionMode ? { sessionMode: currentSessionMode } : {}),
    };
    events.push(tagged);
    input.onEvent?.(tagged);
  };

  const clientApp = acp.client({ name: "agent-bridge" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const response = mapAcpPermissionRequest(ctx.params, {
        executionMode: input.executionMode,
        abortRequested: Boolean(input.abortRequested?.() || input.signal?.aborted),
      });
      remember({
        kind: "permission",
        channel: "live",
        permissionRequest: ctx.params,
        permissionResponse: response,
      });
      return response;
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const observed = gate.observe(ctx.params);
      updates.push(observed);
      remember({
        kind: "session_update",
        channel: observed.channel,
        notification: observed.notification,
      });
      if (observed.channel !== "live") return;
      // Native subagent output is retained for structured lifecycle/activity,
      // but only the parent/root ACP session may feed human-facing live text.
      if (!currentAcpSessionId || observed.notification.sessionId !== currentAcpSessionId) return;
      const payload = observed.notification.update;
      if (payload.sessionUpdate !== "agent_message_chunk" || payload.content.type !== "text") return;
      liveEmitted += payload.content.text;
      input.onLiveText?.(payload.content.text);
    });

  const execute = async (agent: ClientContext): Promise<AcpTurnResult> => {
    const initialize = await agent.request(acp.methods.agent.initialize, bridgeInitializeRequest());
    if (input.authenticateMethodId) {
      const method = initialize.authMethods?.find((candidate) => candidate.id === input.authenticateMethodId);
      if (!method) {
        throw new Error(`ACP agent did not advertise authentication method "${input.authenticateMethodId}"`);
      }
      if (method.type === "terminal") {
        throw new Error(`ACP authentication method "${input.authenticateMethodId}" requires an interactive terminal`);
      }
      await agent.request(acp.methods.agent.authenticate, { methodId: input.authenticateMethodId });
    }

    const sessionParams = { cwd: input.cwd, mcpServers: [] as [] };
    let acpSessionId = input.existingAcpSessionId;
    let sessionMode: AcpSessionMode = "fresh";

    if (acpSessionId && agentSupportsResume(initialize)) {
      sessionMode = "resume";
      currentAcpSessionId = acpSessionId;
      currentSessionMode = sessionMode;
      // ACP v1: session/resume resumes a live connection and does not
      // replay previous messages, so any update observed here (there
      // should be none) stays on the live channel, unlike session/load.
      await agent.request(acp.methods.agent.session.resume, {
        sessionId: acpSessionId,
        ...sessionParams,
      });
    } else if (acpSessionId && agentSupportsLoad(initialize)) {
      sessionMode = "load";
      currentAcpSessionId = acpSessionId;
      currentSessionMode = sessionMode;
      gate.beginLoad();
      await agent.request(acp.methods.agent.session.load, {
        sessionId: acpSessionId,
        ...sessionParams,
      });
      gate.endLoad();
    } else if (acpSessionId) {
      throw new Error("ACP agent does not support resume or load for an existing session");
    } else {
      const created = await agent.request(acp.methods.agent.session.new, sessionParams) as NewSessionResponse;
      acpSessionId = created.sessionId;
      sessionMode = "fresh";
      if (acpSessionId === input.conversationId) {
        throw new Error("ACP session id must not equal the Bridge conversation id");
      }
      currentAcpSessionId = acpSessionId;
      currentSessionMode = sessionMode;
    }

    if (!acpSessionId) throw new Error("ACP session id missing after session setup");

    const blocks = promptBlocks(input.prompt);
    assertPromptCapabilities(blocks, initialize);

    const cancel = () => {
      void agent.notify(acp.methods.agent.session.cancel, { sessionId: acpSessionId });
    };
    if (input.signal?.aborted || input.abortRequested?.()) cancel();
    input.signal?.addEventListener("abort", cancel, { once: true });

    const promptResponse = await agent.request(acp.methods.agent.session.prompt, {
      sessionId: acpSessionId,
      prompt: blocks,
    }, input.signal ? { cancellationSignal: input.signal } : undefined);

    remember({ kind: "stop", channel: "live", stopReason: promptResponse.stopReason });

    const liveText = liveDeliveryText(updates, acpSessionId) || liveEmitted;
    return {
      conversationId: input.conversationId,
      runId: input.runId,
      acpSessionId,
      sessionMode,
      stopReason: promptResponse.stopReason,
      liveText,
      events,
      updates,
      usage: usageFrom(promptResponse),
      contextUsage: contextUsageFrom(updates, acpSessionId),
      initialize,
    };
  };

  if (input.peer) return clientApp.connectWith(input.peer, execute);
  return clientApp.connectWith(input.stream as Stream, execute);
}
