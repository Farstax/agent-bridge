import * as acp from "@agentclientprotocol/sdk";
import { AgentApp } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { NewOutwardAcpSession } from "../repositories/outwardAcpSessionRepository.js";
import {
  BRIDGE_ACP_AGENT_CAPABILITIES,
  BRIDGE_ACP_AGENT_INFO,
  bridgeAgentProtocolVersion,
} from "./capabilities.js";

export interface OutwardAcpSessionStore {
  create(session: NewOutwardAcpSession): unknown;
}

export interface OutwardAcpAgentOptions {
  sessions?: OutwardAcpSessionStore;
}

/**
 * Workspace-local outward ACP agent surface. Session lifecycle is added only
 * when its durable owner is supplied; unsupported methods otherwise remain
 * absent and fail closed through standard ACP method-not-found handling.
 */
export function createOutwardAcpAgent(options: OutwardAcpAgentOptions = {}): AgentApp {
  const app = acp.agent({ name: "agent-bridge" }).onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: bridgeAgentProtocolVersion(),
    agentCapabilities: BRIDGE_ACP_AGENT_CAPABILITIES,
    agentInfo: { ...BRIDGE_ACP_AGENT_INFO },
  }));
  const sessions = options.sessions;
  if (!sessions) return app;

  return app.onRequest(acp.methods.agent.session.new, (ctx) => {
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
}
