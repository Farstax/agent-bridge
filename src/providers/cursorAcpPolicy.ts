import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acpSessionConfigIntents } from "../acp/sessionConfig.js";
import { runAcpApiKeyProbe } from "./acpAuthProbe.js";
import type { AcpProviderPolicy, AcpProviderSessionSettings } from "./acpRuntime.js";
import { resolveCursorAcpArgs, resolveCursorAcpCommand } from "./cursorAcpConfig.js";
import type { ProviderInvocationRequest } from "./types.js";

/**
 * `authenticate({ methodId: "cursor_login" })` blocks indefinitely -- it never
 * responds -- when no cached Cursor login exists (verified live: initialize
 * succeeds, but the authenticate request never resolves against an isolated
 * HOME with no credentials). Only request it when a cached login already
 * exists on disk, so an ordinary Run never hangs; an unauthenticated
 * environment instead surfaces as a normal not_authenticated failure from
 * session/new/prompt.
 *
 * Duplicated (rather than imported) from cursorAvailability.ts's
 * resolveCursorAuthPaths(): that module pulls in apiKeyAuth.ts -> registry.ts,
 * which imports this policy module, so importing it here would be a circular
 * import. Grok's grokAcpPolicy.ts uses the same locally-duplicated-path
 * pattern for the identical reason.
 */
function hasCursorCachedLogin(env: Record<string, string | undefined>): boolean {
  const home = env.HOME?.trim() || homedir();
  return [join(home, ".config", "cursor", "auth.json"), join(home, ".cursor", "auth.json")].some(existsSync);
}

function splitPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

/** Provider-owned authentication preparation; shared auth only dispatches the selected capability. */
export async function verifyCursorAcpApiKey(
  env: Record<string, string | undefined>,
): Promise<void> {
  if (!env.CURSOR_API_KEY?.trim() && !env.CURSOR_AUTH_TOKEN?.trim()) {
    throw new Error("CURSOR_API_KEY is not configured");
  }
  const command = resolveCursorAcpCommand(env);
  await runAcpApiKeyProbe({
    label: "Cursor",
    command,
    args: resolveCursorAcpArgs(env),
    env: { ...env },
    prepareEnv: (root, childEnv) => ({
      ...childEnv,
      HOME: root,
      NO_BROWSER: "1",
    }),
  });
}

function sessionSettings(
  request: ProviderInvocationRequest,
  env: Record<string, string | undefined>,
): AcpProviderSessionSettings {
  const config = acpSessionConfigIntents("cursor", request, {
    model: splitPreference(env.CURSOR_MODEL_PREFERENCE),
    thoughtLevel: env.CURSOR_EFFORT?.trim() ? [env.CURSOR_EFFORT.trim()] : [],
  });
  return {
    // Explicitly pin Cursor's session permission mode rather than trusting
    // whatever session/new happens to default to. Cursor advertises
    // "default" (per-tool permission prompts, Bridge-owned), "auto_edit",
    // and "yolo" (auto-approve everything) as selectable modes -- Claude's
    // policy pins modeId the same way for the identical reason.
    modeId: "default",
    ...(config.length > 0 ? { config } : {}),
  };
}

const CURSOR_QUALIFICATION_ENV_KEYS = [
  "CURSOR_ACP_COMMAND",
  "CURSOR_ACP_ARGS",
  "CURSOR_MODEL_PREFERENCE",
  "CURSOR_EFFORT",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "BRIDGE_CURRENT_RELEASE_DIR",
] as const;

/** Cursor-specific policy only; lifecycle/session/replay/cancel/presentation stay in the shared ACP runtime. */
export const cursorAcpPolicy: AcpProviderPolicy = {
  providerId: "cursor",
  registryAgentId: "cursor",
  toolFree: false,
  // Issue #748: do not enable steering from advertisement. Cursor ACP has not
  // been independently qualified for a host-owned idle contract.
  steeringSupported: false,
  presentation: {
    provisionalAnswers: true,
  },
  resolveExecutable: resolveCursorAcpCommand,
  resolveArgs: (env, entry) => resolveCursorAcpArgs(env, entry),
  qualificationEnvKeys: CURSOR_QUALIFICATION_ENV_KEYS,
  // Cached account login is authoritative over an optional API key -- Agent
  // Bridge deliberately withholds an unverified candidate key from the
  // provider child, so a stale/invalid optional CURSOR_API_KEY must not
  // suppress an otherwise-valid cached-login handshake (see #791's account-
  // auth-precedence fix for Grok, same defect class).
  authenticateMethodId: (env) => (hasCursorCachedLogin(env) ? "cursor_login" : undefined),
  verifyApiKey: verifyCursorAcpApiKey,
  sessionSettings,
};
