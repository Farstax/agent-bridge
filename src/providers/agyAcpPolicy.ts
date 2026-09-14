import { homedir } from "node:os";
import { acpSessionConfigIntents } from "../acp/sessionConfig.js";
import type { AcpProviderPolicy, AcpProviderSessionSettings } from "./acpRuntime.js";
import { resolveAgyAcpArgs, resolveAgyAcpCommand } from "./agyAcpConfig.js";
import { hasAgyAcpCachedAuth } from "./agyAvailability.js";
import type { ProviderInvocationRequest } from "./types.js";

function splitPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function sessionSettings(
  request: ProviderInvocationRequest,
  env: Record<string, string | undefined>,
): AcpProviderSessionSettings {
  const config = acpSessionConfigIntents("antigravity", request, {
    model: splitPreference(env.ANTIGRAVITY_MODEL_PREFERENCE),
    thoughtLevel: env.ANTIGRAVITY_EFFORT?.trim() ? [env.ANTIGRAVITY_EFFORT.trim()] : [],
  });
  return config.length > 0 ? { config } : {};
}

const AGY_QUALIFICATION_ENV_KEYS = [
  "AGY_ACP_COMMAND",
  "AGY_ACP_ARGS",
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
  // Issue #748: do not enable steering from advertisement. antigravity-acp@1.1.1
  // is not independently qualified for a host-owned idle contract.
  steeringSupported: false,
  presentation: {
    provisionalAnswers: true,
  },
  resolveExecutable: resolveAgyAcpCommand,
  resolveArgs: (env, entry) => resolveAgyAcpArgs(env, entry),
  qualificationEnvKeys: AGY_QUALIFICATION_ENV_KEYS,
  // `authenticate({ methodId: "oauth-personal" })` launches an interactive
  // Google OAuth browser flow when no cached antigravity-acp credential
  // exists. Only request it when a cached exchange is already on disk, so an
  // ordinary Run never hangs waiting on a browser login; an unauthenticated
  // environment instead surfaces as a normal not_authenticated failure from
  // session/new/prompt.
  authenticateMethodId: (env) => (
    hasAgyAcpCachedAuth({ homeDir: env.HOME?.trim() || homedir(), env }) ? "oauth-personal" : undefined
  ),
  sessionSettings,
};
