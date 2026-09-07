import { PROTOCOL_VERSION, type ClientCapabilities, type InitializeRequest } from "@agentclientprotocol/sdk";

/**
 * Client capabilities Agent Bridge actually needs. Permission requests are a
 * baseline ACP client method and do not require a capability advertisement.
 * Filesystem and terminal execution stay with the provider agent.
 */
export const BRIDGE_ACP_CLIENT_CAPABILITIES: ClientCapabilities = {};

export const BRIDGE_ACP_CLIENT_INFO = {
  name: "agent-bridge",
  title: "Agent Bridge",
  version: "0.1.0",
} as const;

export function bridgeInitializeRequest(): InitializeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: BRIDGE_ACP_CLIENT_CAPABILITIES,
    clientInfo: { ...BRIDGE_ACP_CLIENT_INFO },
  };
}
