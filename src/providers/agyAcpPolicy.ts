import { acpSessionConfigIntents } from "../acp/sessionConfig.js";
import type { AcpProviderPolicy, AcpProviderSessionSettings } from "./acpRuntime.js";
import { assertAgyAcpVersion, resolveAgyAcpArgs, resolveAgyAcpCommand } from "./agyAcpConfig.js";
import type { ProviderInvocationRequest } from "./types.js";

function splitPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function sessionSettings(
  request: ProviderInvocationRequest,
  env: Record<string, string | undefined>,
): AcpProviderSessionSettings {
  const config = acpSessionConfigIntents("antigravity", request, {
    model: request.preferProviderDefaults ? [] : splitPreference(env.ANTIGRAVITY_MODEL_PREFERENCE),
    thoughtLevel: !request.preferProviderDefaults && env.ANTIGRAVITY_EFFORT?.trim() ? [env.ANTIGRAVITY_EFFORT.trim()] : [],
  });
  return config.length > 0 ? { config } : {};
}

const AGY_QUALIFICATION_ENV_KEYS = [
  "AGY_ACP_COMMAND",
  "AGY_ACP_ARGS",
  "AGENT_BRIDGE_AGY_ACP_LINK",
  "GEMINI_HOME",
  "ANTIGRAVITY_MODEL_PREFERENCE",
  "ANTIGRAVITY_EFFORT",
  "BRIDGE_CURRENT_RELEASE_DIR",
] as const;

/** Agy-specific policy only; lifecycle/session/replay/cancel/presentation stay in the shared ACP runtime. */
export const agyAcpPolicy: AcpProviderPolicy = {
  providerId: "agy",
  registryAgentId: "antigravity-acp",
  toolFree: true,
  // Issue #748: do not enable steering from advertisement. The locked ACP
  // runtime is not independently qualified for a host-owned idle contract.
  steeringSupported: false,
  presentation: {
    provisionalAnswers: true,
  },
  resolveExecutable: resolveAgyAcpCommand,
  resolveArgs: (env, entry) => resolveAgyAcpArgs(env, entry),
  validateRuntime: (runtime, env) => {
    assertAgyAcpVersion(runtime.executable, runtime.selectedVersion);
  },
  qualificationEnvKeys: AGY_QUALIFICATION_ENV_KEYS,
  // The official CLI reuses its own cached sign-in during session/new.
  // Never start interactive OAuth from an ordinary Run; Desk owns sign-in.
  sessionSettings,
};
