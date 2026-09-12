import * as acp from "@agentclientprotocol/sdk";
import { AgentApp } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  NewOutwardAcpSession,
  OutwardAcpSessionRecord,
} from "../repositories/outwardAcpSessionRepository.js";
import type { OutwardAcpPromptExecutor } from "./execution.js";
import {
  BRIDGE_ACP_AGENT_CAPABILITIES,
  BRIDGE_ACP_AGENT_INFO,
  bridgeAgentProtocolVersion,
} from "./capabilities.js";

export interface OutwardAcpSessionStore {
  create(session: NewOutwardAcpSession): unknown;
  get?(sessionId: string): OutwardAcpSessionRecord | null;
}

export interface OutwardAcpAgentOptions {
  sessions?: OutwardAcpSessionStore;
  promptExecutor?: OutwardAcpPromptExecutor;
}

function promptText(prompt: readonly acp.ContentBlock[]): string {
  return prompt.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource_link") {
      return `[ACP resource_link]\n${JSON.stringify(block)}`;
    }
    throw acp.RequestError.invalidParams(
      { field: "prompt" },
      `outward ACP does not advertise support for ${block.type} prompt blocks`,
    );
  }).join("\n\n");
}

/**
 * Workspace-local outward ACP agent surface. Lifecycle methods are registered
 * only when their durable/runtime owners are supplied; unsupported methods
 * otherwise stay absent and fail closed through ACP method-not-found handling.
 */
export function createOutwardAcpAgent(options: OutwardAcpAgentOptions = {}): AgentApp {
  let app = acp.agent({ name: "agent-bridge" }).onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: bridgeAgentProtocolVersion(),
    agentCapabilities: BRIDGE_ACP_AGENT_CAPABILITIES,
    agentInfo: { ...BRIDGE_ACP_AGENT_INFO },
  }));
  const sessions = options.sessions;
  if (!sessions) return app;

  app = app.onRequest(acp.methods.agent.session.new, (ctx) => {
    if (!isAbsolute(ctx.params.cwd)) {
      throw acp.RequestError.invalidParams(
        { field: "cwd" },
        "session cwd must be an absolute path",
      );
    }
    if ((ctx.params.additionalDirectories?.length ?? 0) > 0) {
      throw acp.RequestError.invalidParams(
        { field: "additionalDirectories" },
        "outward additional directories are not supported",
      );
    }
    if (ctx.params.mcpServers.length > 0) {
      throw acp.RequestError.invalidParams(
        { field: "mcpServers" },
        "outward MCP servers are not supported",
      );
    }

    const sessionId = randomUUID();
    const conversationId = `acp:${randomUUID()}`;
    sessions.create({ sessionId, conversationId, cwd: ctx.params.cwd });
    return { sessionId };
  });

  if (!options.promptExecutor || !sessions.get) return app;
  const promptExecutor = options.promptExecutor;
  const getSession = sessions.get.bind(sessions);
  app = app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = getSession(ctx.params.sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams(
        { field: "sessionId" },
        "unknown outward ACP session",
      );
    }
    return promptExecutor.execute({
      session,
      prompt: promptText(ctx.params.prompt),
      signal: ctx.signal,
      onUpdate: (update) => ctx.client.notify(acp.methods.client.session.update, {
        sessionId: session.sessionId,
        update,
      }),
    });
  });

  return app.onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    const session = getSession(ctx.params.sessionId);
    if (!session) return;
    await promptExecutor.cancel(session);
  });
}
