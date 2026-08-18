import { isProviderId } from "./providers/registry.js";
import type { AdvisorConfig, AdvisorTarget } from "./advisorTypes.js";

type Env = Record<string, string | undefined>;
const positiveInt = (raw: string | undefined, fallback: number) => {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
function parseTarget(raw: string): AdvisorTarget | null {
  const split = raw.indexOf(":");
  if (split <= 0) return null;
  const rawProvider = raw.slice(0, split).trim();
  const provider = rawProvider === "antigravity" ? "agy" : rawProvider;
  const model = raw.slice(split + 1).trim();
  return isProviderId(provider) && model ? { provider, model } : null;
}

export function parseAdvisorConfig(env: Env = process.env): AdvisorConfig {
  return {
    enabled: /^(?:1|true|yes|on)$/i.test(env.BRIDGE_ADVISOR_ENABLED ?? ""),
    // Policy moved to the native provider Skill. Bridge itself never suggests or auto-runs Advisor.
    mode: "manual",
    chain: (env.BRIDGE_ADVISOR_CHAIN ?? "").split(",").map((value) => parseTarget(value.trim()))
      .filter((value): value is AdvisorTarget => value !== null),
    maxCallsPerTurn: positiveInt(env.BRIDGE_ADVISOR_MAX_CALLS_PER_TURN, 1),
    maxCallsPerTask: positiveInt(env.BRIDGE_ADVISOR_MAX_CALLS_PER_TASK, 2),
    timeoutMs: positiveInt(env.BRIDGE_ADVISOR_TIMEOUT_MS, 120_000),
    questionMaxChars: positiveInt(env.BRIDGE_ADVISOR_QUESTION_MAX_CHARS, 4_000),
    contextMaxChars: positiveInt(env.BRIDGE_ADVISOR_CONTEXT_MAX_CHARS, 24_000),
    outputMaxChars: positiveInt(env.BRIDGE_ADVISOR_OUTPUT_MAX_CHARS, 16_000),
  };
}
