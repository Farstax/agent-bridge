import * as acp from "@agentclientprotocol/sdk";
import { AgentApp } from "@agentclientprotocol/sdk";
import {
  BRIDGE_ACP_AGENT_CAPABILITIES,
  BRIDGE_ACP_AGENT_INFO,
  bridgeAgentProtocolVersion,
} from "./capabilities.js";

/**
 * Workspace-local outward ACP agent surface. Only `initialize` is
 * implemented; session lifecycle methods are deliberately unregistered so
 * callers get a standard ACP method-not-found error instead of a promised
 * capability that does not exist yet (#733 first slice).
 */
export function createOutwardAcpAgent(): AgentApp {
  return acp.agent({ name: "agent-bridge" }).onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: bridgeAgentProtocolVersion(),
    agentCapabilities: BRIDGE_ACP_AGENT_CAPABILITIES,
    agentInfo: { ...BRIDGE_ACP_AGENT_INFO },
  }));
}
