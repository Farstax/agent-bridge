import { existsSync } from "node:fs";
import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { homedir } from "node:os";
import { join } from "node:path";
import { acpSessionConfigIntents } from "../acp/sessionConfig.js";
import { AcpLogicalMessageReconstructor, renderLogicalMessages } from "../acp/logicalMessages.js";
import type { AcpRetainedEvent, AcpTurnResult } from "../acp/client.js";
import { runAcpApiKeyProbe } from "./acpAuthProbe.js";
import type { AcpAnswerPreview, AcpProviderPolicy, AcpProviderSessionSettings } from "./acpRuntime.js";
import { createStreamingSecretRedactor } from "./streamingSecretRedactor.js";
import { resolveGrokAcpArgs, resolveGrokAcpCommand } from "./grokAcpConfig.js";
import type { ProviderInvocationRequest } from "./types.js";

function splitPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function grokAuthPath(env: Record<string, string | undefined>): string {
  const explicit = env.GROK_AUTH_PATH?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || homedir();
  const grokHome = env.GROK_HOME?.trim() || join(home, ".grok");
  return join(grokHome, "auth.json");
}

function hasGrokCachedAccountAuth(env: Record<string, string | undefined>): boolean {
  return existsSync(grokAuthPath(env));
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
    model: request.preferProviderDefaults ? [] : splitPreference(env.GROK_MODEL_PREFERENCE),
    thoughtLevel: !request.preferProviderDefaults && env.GROK_EFFORT?.trim() ? [env.GROK_EFFORT.trim()] : [],
  });
  return config.length > 0 ? { config } : {};
}

/**
 * Grok does not supply commentary phases or message IDs. Its observed ordinary
 * Runs put a progress message before a tool, then start a new answer message.
 * A tool alone is not enough: classify the earlier message only once the next
 * logical assistant message actually begins. Otherwise preserve the full answer.
 *
 * This is Grok policy, not a provider-neutral inference from arbitrary prose.
 */
function createGrokMessageSelection() {
  const logical = new AcpLogicalMessageReconstructor();
  const interimIndices = new Set<number>();
  let toolBetweenMessages = false;
  return {
    observe(update: SessionUpdate): { text: string; key: string } | null {
      if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        && logical.messages.length > 0) toolBetweenMessages = true;
      const fragment = logical.observe(update);
      if (!fragment) return null;
      let interim: { text: string; key: string } | null = null;
      if (fragment.startsMessage && fragment.messageIndex > 0 && toolBetweenMessages) {
        const preceding = fragment.messageIndex - 1;
        interimIndices.add(preceding);
        interim = { text: logical.messages[preceding]!.text, key: String(preceding + 1) };
      }
      // A tool inside one messageId is not a boundary; never classify from it.
      toolBetweenMessages = false;
      return interim;
    },
    answer(): string {
      return renderLogicalMessages(logical.messages.filter((_, index) => !interimIndices.has(index)));
    },
  };
}

function isLiveRootGrokUpdate(event: AcpRetainedEvent): event is AcpRetainedEvent & { notification: NonNullable<AcpRetainedEvent["notification"]> } {
  return event.kind === "session_update" && event.channel === "live" && !event.presentationSuppressed
    && event.notification !== undefined
    && (!event.acpSessionId || event.notification.sessionId === event.acpSessionId);
}

/** Share exact boundary/authority semantics between provisional and final Grok text. */
export function selectGrokAcpAnswer(result: AcpTurnResult): { text: string; missingDescription: string } {
  const selection = createGrokMessageSelection();
  for (const event of result.updates ?? []) {
    if (event.channel === "live" && event.notification.sessionId === result.acpSessionId) {
      selection.observe(event.notification.update);
    }
  }
  return {
    text: selection.answer() || result.liveText,
    missingDescription: "live answer text",
  };
}

export function createGrokAcpAnswerPreview(
  onAnswerDelta: (text: string) => void,
  secrets: readonly string[],
  onCommentary?: (text: string, messageKey?: string) => void,
): AcpAnswerPreview {
  const selection = createGrokMessageSelection();
  const redact = (text: string): string => {
    const redactor = createStreamingSecretRedactor(secrets);
    return redactor.push(text) + redactor.flush();
  };
  return {
    observe(event): void {
      if (!isLiveRootGrokUpdate(event)) return;
      const interim = selection.observe(event.notification.update);
      if (interim && onCommentary) {
        const safe = redact(interim.text);
        if (safe) onCommentary(safe, interim.key);
      }
    },
    finish(stopReason): void {
      if (stopReason === "cancelled") return;
      // The last message is not known to be final until settlement. Never
      // show an ambiguous pre-tool fragment as an irreversible answer preview.
      const safe = redact(selection.answer());
      if (safe) onAnswerDelta(safe);
    },
  };
}

const GROK_QUALIFICATION_ENV_KEYS = [
  "GROK_ACP_COMMAND",
  "GROK_ACP_ARGS",
  "GROK_MODEL_PREFERENCE",
  "GROK_EFFORT",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_HOME",
  "GROK_AUTH_PATH",
  "BRIDGE_CURRENT_RELEASE_DIR",
] as const;

/** Grok-specific policy only; lifecycle/session/replay/cancel/presentation stay in the shared ACP runtime. */
export const grokAcpPolicy: AcpProviderPolicy = {
  providerId: "grok",
  registryAgentId: "grok-build",
  toolFree: false,
  // Issue #748: do not enable steering from advertisement. Grok 1.0.41 has not
  // advertise a host-owned idle contract; keep the existing augment fallback.
  steeringSupported: false,
  presentation: {
    provisionalAnswers: true,
    createPreview: createGrokAcpAnswerPreview,
  },
  selectAnswer: selectGrokAcpAnswer,
  resolveExecutable: resolveGrokAcpCommand,
  resolveArgs: (env, entry) => resolveGrokAcpArgs(env, entry),
  qualificationEnvKeys: GROK_QUALIFICATION_ENV_KEYS,
  // Grok account auth is deliberately authoritative when present. A configured
  // optional API key is not proof of usable key auth and must not suppress the
  // cached-token handshake; the supervisor independently verifies candidate
  // keys before exposing them to the provider child.
  authenticateMethodId: (env) => (hasGrokCachedAccountAuth(env) ? "cached_token" : undefined),
  verifyApiKey: verifyGrokAcpApiKey,
  sessionSettings,
};
