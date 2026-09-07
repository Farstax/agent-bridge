import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentApp,
  ClientContext,
  ContentBlock,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
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
}

export interface AcpTurnInput {
  readonly cwd: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly existingAcpSessionId: string | null;
  readonly prompt: string | ContentBlock | ContentBlock[];
  readonly executionMode: "safe" | "trusted";
  readonly abortRequested?: () => boolean;
  readonly signal?: AbortSignal;
  readonly stream?: Stream;
  readonly peer?: AgentApp;
  readonly onLiveText?: (text: string) => void;
  readonly onEvent?: (event: AcpRetainedEvent) => void;
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
  readonly usage?: Usage;
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

function agentSupportsClose(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.sessionCapabilities?.close);
}

function usageFrom(response: PromptResponse, updates: readonly AcpObservedUpdate[]): Usage | undefined {
  if (response.usage) return response.usage;
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const update = updates[i].notification.update;
    if (update.sessionUpdate === "usage_update") {
      return {
        totalTokens: update.used,
        inputTokens: update.used,
        outputTokens: 0,
      };
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

  const remember = (event: AcpRetainedEvent) => {
    events.push(event);
    input.onEvent?.(event);
  };

  const clientApp = acp.client({ name: "agent-bridge" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const response = mapAcpPermissionRequest(ctx.params, {
        executionMode: input.executionMode,
        abortRequested: Boolean(input.abortRequested?.() || input.signal?.aborted),
      });
      remember({ kind: "permission", channel: "live" });
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
      const payload = observed.notification.update;
      if (payload.sessionUpdate !== "agent_message_chunk" || payload.content.type !== "text") return;
      liveEmitted += payload.content.text;
      input.onLiveText?.(payload.content.text);
    });

  const execute = async (agent: ClientContext): Promise<AcpTurnResult> => {
    const initialize = await agent.request(acp.methods.agent.initialize, bridgeInitializeRequest());
    const sessionParams = { cwd: input.cwd, mcpServers: [] as [] };
    let acpSessionId = input.existingAcpSessionId;
    let sessionMode: AcpSessionMode = "fresh";

    if (acpSessionId && agentSupportsResume(initialize)) {
      sessionMode = "resume";
      gate.beginResume();
      await agent.request(acp.methods.agent.session.resume, {
        sessionId: acpSessionId,
        ...sessionParams,
      });
      gate.endResume();
    } else if (acpSessionId && agentSupportsLoad(initialize)) {
      sessionMode = "load";
      gate.beginLoad();
      await agent.request(acp.methods.agent.session.load, {
        sessionId: acpSessionId,
        ...sessionParams,
      });
      gate.endLoad();
    } else {
      const created = await agent.request(acp.methods.agent.session.new, sessionParams) as NewSessionResponse;
      acpSessionId = created.sessionId;
      sessionMode = "fresh";
      if (acpSessionId === input.conversationId) {
        throw new Error("ACP session id must not equal the Bridge conversation id");
      }
    }

    if (!acpSessionId) throw new Error("ACP session id missing after session setup");

    const cancel = () => {
      void agent.notify(acp.methods.agent.session.cancel, { sessionId: acpSessionId });
    };
    if (input.signal?.aborted || input.abortRequested?.()) cancel();
    input.signal?.addEventListener("abort", cancel, { once: true });

    const promptResponse = await agent.request(acp.methods.agent.session.prompt, {
      sessionId: acpSessionId,
      prompt: promptBlocks(input.prompt),
    }, input.signal ? { cancellationSignal: input.signal } : undefined);

    remember({ kind: "stop", channel: "live", stopReason: promptResponse.stopReason });

    if (agentSupportsClose(initialize)) {
      await agent.request(acp.methods.agent.session.close, { sessionId: acpSessionId }).catch(() => undefined);
    }

    const liveText = liveDeliveryText(updates) || liveEmitted;
    return {
      conversationId: input.conversationId,
      runId: input.runId,
      acpSessionId,
      sessionMode,
      stopReason: promptResponse.stopReason,
      liveText,
      events,
      updates,
      usage: usageFrom(promptResponse, updates),
      initialize,
    };
  };

  if (input.peer) return clientApp.connectWith(input.peer, execute);
  return clientApp.connectWith(input.stream as Stream, execute);
}
