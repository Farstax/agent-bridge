export function parseHealthEnabled(env: Record<string, string | undefined>): boolean {
  return env.HEALTH_MONITOR_ENABLED === "true";
}

export type HealthBotMode = "standalone" | "integrated";

/** The standalone bot remains the default to preserve existing installations. */
export function parseHealthBotMode(env: Record<string, string | undefined>): HealthBotMode {
  const value = env.HEALTH_BOT_MODE ?? "standalone";
  if (value === "standalone" || value === "integrated") return value;
  throw new Error("HEALTH_BOT_MODE must be standalone or integrated");
}

export function resolveHealthTelegramToken(env: Record<string, string | undefined>): string | undefined {
  return parseHealthBotMode(env) === "integrated"
    ? env.TELEGRAM_BOT_TOKEN_INTERACTIVE
    : env.TELEGRAM_BOT_TOKEN_HEALTH;
}

export function shouldHealthServicePoll(env: Record<string, string | undefined>): boolean {
  return parseHealthBotMode(env) === "standalone";
}

export function parseCadenceSeconds(env: Record<string, string | undefined>): number {
  const n = Number(env.HEALTH_MONITOR_CADENCE_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

type BotKind = "codex" | "antigravity" | "claude";

function parseBot(value: string | undefined): BotKind {
  if (value === "codex" || value === "antigravity" || value === "claude") return value;
  return "claude";
}

/**
 * Execution mode for the health bot's interactive engine (user-prompted chat
 * turns only). Mirrors resolveExecutionMode semantics: per-bot env var wins
 * over BRIDGE_EXECUTION_MODE, default safe. The autonomous suggestion path in
 * suggest.ts is intentionally pinned to safe and does not consult this.
 */
export function resolveHealthEngineExecutionMode(
  env: Record<string, string | undefined>,
  bot: BotKind,
): "safe" | "trusted" {
  const perBotRaw = env[`${bot.toUpperCase()}_EXECUTION_MODE`];
  if (perBotRaw === "safe" || perBotRaw === "trusted") return perBotRaw;
  const globalRaw = env.BRIDGE_EXECUTION_MODE;
  if (globalRaw === "safe" || globalRaw === "trusted") return globalRaw;
  return "safe";
}

/**
 * Parses health CLI config from env vars. HEALTH_SUGGEST_* is canonical;
 * HEALTH_CLI_* is a compatibility alias and only wins when the SUGGEST variant is absent.
 */
export function parseHealthCliConfig(env: Record<string, string | undefined>): {
  bot: BotKind;
  command: string | undefined;
  modelPreference: string[];
} {
  const bot = parseBot(env.HEALTH_SUGGEST_BOT ?? env.HEALTH_CLI_BOT);
  const command = env.HEALTH_SUGGEST_COMMAND ?? env.HEALTH_CLI_COMMAND;
  const modelRaw = env.HEALTH_SUGGEST_MODEL_PREFERENCE ?? env.HEALTH_CLI_MODEL_PREFERENCE ?? "";
  const modelPreference = modelRaw.split(",").map(s => s.trim()).filter(Boolean);
  return { bot, command, modelPreference };
}
