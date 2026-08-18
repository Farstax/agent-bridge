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
