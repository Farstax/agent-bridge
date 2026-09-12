import { PROTOCOL_VERSION, type AgentCapabilities, type Implementation } from "@agentclientprotocol/sdk";

/**
 * Capabilities Agent Bridge truthfully guarantees as an outward ACP agent
 * today. Session lifecycle (`session/new`, `session/prompt`, etc.) is not
 * implemented yet, so this advertises no prompt/MCP/load-session support
 * rather than promising a capability the current outward contract cannot
 * satisfy.
 */
export const BRIDGE_ACP_AGENT_CAPABILITIES: AgentCapabilities = {
  loadSession: false,
};

export const BRIDGE_ACP_AGENT_INFO: Implementation = {
  name: "agent-bridge",
  title: "Agent Bridge",
  version: "0.1.0",
};

export function bridgeAgentProtocolVersion(): number {
  return PROTOCOL_VERSION;
}
