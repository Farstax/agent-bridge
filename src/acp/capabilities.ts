import { PROTOCOL_VERSION, type ClientCapabilities, type InitializeRequest } from "@agentclientprotocol/sdk";

/** Draft ACP subagent-session extension supported by the pinned codex-acp adapter. */
type SubagentAwareClientCapabilities = ClientCapabilities & {
  subagents?: Record<string, never>;
};

/**
 * Client capabilities Agent Bridge actually needs. Permission requests are a
 * baseline ACP client method and do not require a capability advertisement.
 * Filesystem and terminal execution stay with the provider agent — `fs` and
 * `terminal` are deliberately not advertised. `plan: {}` tells the agent
 * Bridge can receive plan_update/plan_removed session updates; `subagents: {}`
 * truthfully advertises that Bridge can receive the adapter's structured
 * native subagent lifecycle extension. The field remains generic ACP plumbing,
 * not provider policy.
 */
export const BRIDGE_ACP_CLIENT_CAPABILITIES: SubagentAwareClientCapabilities = {
  plan: {},
  subagents: {},
};

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
