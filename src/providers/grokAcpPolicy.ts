import { join } from "node:path";
import { acpSessionConfigIntents } from "../acp/sessionConfig.js";
import { runAcpApiKeyProbe } from "./acpAuthProbe.js";
import type { AcpProviderPolicy, AcpProviderSessionSettings } from "./acpRuntime.js";
import { resolveGrokAcpArgs, resolveGrokAcpCommand } from "./grokAcpConfig.js";
import type { ProviderInvocationRequest } from "./types.js";

function splitPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

/** Provider-owned authentication preparation; shared auth only dispatches the selected capability. */
export async function verifyGrokAcpApiKey(
  env: Record<string, string | undefined>,
): Promise<void> {
  if (!env.XAI_API_KEY?.trim() && !env.GROK_CODE_XAI_API_KEY?.trim()) {
    throw new Error("XAI_API_KEY is not configured");
  }
  const command = resolveGrokAcpCommand(env);
  await runAcpApiKeyProbe({
    label: "Grok",
    command,
    args: resolveGrokAcpArgs(env),
    env: { ...env },
    prepareEnv: (root, childEnv) => ({
      ...childEnv,
      HOME: root,
      GROK_HOME: join(root, ".grok"),
      NO_BROWSER: "1",
    }),
  });
}

function sessionSettings(
  request: ProviderInvocationRequest,
  env: Record<string, string | undefined>,
): AcpProviderSessionSettings {
  const config = acpSessionConfigIntents("grok", request, {
    model: splitPreference(env.GROK_MODEL_PREFERENCE),
    thoughtLevel: env.GROK_EFFORT?.trim() ? [env.GROK_EFFORT.trim()] : [],
  });
  return config.length > 0 ? { config } : {};
}

const GROK_QUALIFICATION_ENV_KEYS = [
  "GROK_ACP_COMMAND",
  "GROK_ACP_ARGS",
  "GROK_MODEL_PREFERENCE",
  "GROK_EFFORT",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_HOME",
  "BRIDGE_CURRENT_RELEASE_DIR",
] as const;

/** Grok-specific policy only; lifecycle/session/replay/cancel/presentation stay in the shared ACP runtime. */
export const grokAcpPolicy: AcpProviderPolicy = {
  providerId: "grok",
  registryAgentId: "grok-build",
  toolFree: false,
  // Issue #748: do not enable steering from advertisement. Grok 1.0.30 did not
  // advertise a host-owned idle contract; keep the existing augment fallback.
  steeringSupported: false,
  presentation: {
    provisionalAnswers: true,
  },
  resolveExecutable: resolveGrokAcpCommand,
  resolveArgs: (env, entry) => resolveGrokAcpArgs(env, entry),
  qualificationEnvKeys: GROK_QUALIFICATION_ENV_KEYS,
  authenticateMethodId: (env) => (env.XAI_API_KEY?.trim() || env.GROK_CODE_XAI_API_KEY?.trim()
    ? undefined
    : "cached_token"),
  verifyApiKey: verifyGrokAcpApiKey,
  sessionSettings,
};
