import { PROTOCOL_VERSION, type ClientCapabilities, type InitializeRequest } from "@agentclientprotocol/sdk/unstable";

/** Draft ACP subagent-session extension supported by the pinned codex-acp adapter. */
type SubagentAwareClientCapabilities = ClientCapabilities & {
  subagents?: Record<string, never>;
  session?: { notices?: Record<string, never> };
};

/**
 * Client capabilities Agent Bridge actually needs. Permission requests are a
 * baseline ACP client method and do not require a capability advertisement.
 * Filesystem and terminal execution stay with the provider agent — `fs` and
 * `terminal` are deliberately not advertised. `plan: {}` tells the agent
 * Bridge can receive plan_update/plan_removed session updates; `subagents: {}`
 * truthfully advertises that Bridge can receive the adapter's structured
 * native subagent lifecycle extension. `session.notices` makes supported
 * provider advisories typed diagnostics rather than assistant text.
 * These fields remain generic ACP plumbing,
 * not provider policy.
 */
export const BRIDGE_ACP_CLIENT_CAPABILITIES: SubagentAwareClientCapabilities = {
  plan: {},
  subagents: {},
  session: { notices: {} },
};

export const BRIDGE_ACP_CLIENT_INFO = {
  name: "agent-bridge",
  title: "Agent Bridge",
  version: "0.1.0",
} as const;

export function bridgeInitializeRequest(providerId?: string): InitializeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    // codex-acp 2.6.0 requires AIR client negotiation for explicit message
    // phases. No optional AIR capabilities: preserve baseline permissions and
    // leave every other ACP provider's initialization unchanged.
    clientCapabilities: providerId === "codex"
      ? {
          ...BRIDGE_ACP_CLIENT_CAPABILITIES,
          _meta: { jetbrains: { air: { version: 1, capabilities: [] } } },
        }
      : BRIDGE_ACP_CLIENT_CAPABILITIES,
    clientInfo: { ...BRIDGE_ACP_CLIENT_INFO },
  };
}
