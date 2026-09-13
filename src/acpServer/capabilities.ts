import { PROTOCOL_VERSION, type AgentCapabilities, type Implementation } from "@agentclientprotocol/sdk";

/**
 * Capabilities Agent Bridge truthfully guarantees as an outward ACP agent.
 * `loadSession` reflects whether the durable session store handed to
 * `createOutwardAcpAgent` actually supports history replay, rather than
 * promising a capability the current wiring cannot satisfy.
 */
export function bridgeAgentCapabilities(options: { loadSession: boolean }): AgentCapabilities {
  return { loadSession: options.loadSession };
}

export const BRIDGE_ACP_AGENT_INFO: Implementation = {
  name: "agent-bridge",
  title: "Agent Bridge",
  version: "0.1.0",
};

export function bridgeAgentProtocolVersion(): number {
  return PROTOCOL_VERSION;
}
