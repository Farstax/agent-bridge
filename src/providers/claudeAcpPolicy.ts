import type { AcpProviderPolicy, AcpProviderSessionSettings } from "./acpRuntime.js";
import type { ProviderInvocationRequest } from "./types.js";
import { resolveClaudeAcpArgs, resolveClaudeAcpCommand } from "./claudeAcpConfig.js";

function sessionSettings(request: ProviderInvocationRequest): AcpProviderSessionSettings {
  const config: Array<{ configId: string; value: string }> = [];
  if (request.model) config.push({ configId: "model", value: request.model });
  if (request.effort) config.push({ configId: "effort", value: request.effort });

  return {
    // Keep Claude in manual permission mode. Agent Bridge remains the authority
    // that approves/denies each ACP permission request for safe/trusted Runs.
    modeId: "default",
    ...(config.length > 0 ? { config } : {}),
    meta: {
      ...(request.toolMode === "none" ? { disableBuiltInTools: true } : {}),
      claudeCode: {
        options: {
          // Local settings can contain allow rules that bypass the ACP
          // permission callback. Bridge remains the permission authority.
          settingSources: [],
          ...(request.toolMode === "none"
            ? { tools: [], mcpServers: {}, strictMcpConfig: true }
            : {}),
        },
      },
    },
  };
}

const CLAUDE_QUALIFICATION_ENV_KEYS = [
  "CLAUDE_ACP_COMMAND",
  "CLAUDE_ACP_ARGS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_EXECUTABLE",
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
  resolveExecutable: resolveClaudeAcpCommand,
  resolveArgs: (env) => resolveClaudeAcpArgs(env),
  qualificationEnvKeys: CLAUDE_QUALIFICATION_ENV_KEYS,
  sessionSettings,
};
