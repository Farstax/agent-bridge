import type { AcpProviderPolicy, AcpProviderSessionSettings } from "./acpRuntime.js";
import type { ProviderInvocationRequest } from "./types.js";

function sessionSettings(request: ProviderInvocationRequest): AcpProviderSessionSettings {
  const config: Array<{ configId: string; value: string }> = [];
  if (request.model) config.push({ configId: "model", value: request.model });
  if (request.effort) config.push({ configId: "effort", value: request.effort });

  return {
    // Keep Claude in manual permission mode. Agent Bridge remains the authority
    // that approves/denies each ACP permission request for safe/trusted Runs.
    modeId: "default",
    ...(config.length > 0 ? { config } : {}),
    ...(request.toolMode === "none"
      ? {
          meta: {
            disableBuiltInTools: true,
            claudeCode: {
              options: {
                tools: [],
                mcpServers: {},
                settingSources: [],
              },
            },
          },
        }
      : {}),
  };
}

const CLAUDE_QUALIFICATION_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "BRIDGE_CURRENT_RELEASE_DIR",
] as const;

/** Claude-specific policy only; lifecycle/session/replay/cancel/presentation stay in the shared ACP runtime. */
export const claudeAcpPolicy: AcpProviderPolicy = {
  providerId: "claude",
  registryAgentId: "claude-acp",
  toolFree: true,
  presentation: {
    provisionalAnswers: true,
  },
  qualificationEnvKeys: CLAUDE_QUALIFICATION_ENV_KEYS,
  sessionSettings,
};
