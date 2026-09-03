/**
 * PURPOSE: Standard effort-level config and CLI argument mapping.
 * INPUTS: Bot kind, BridgeDb settings and environment defaults.
 * OUTPUTS: Validated effort levels, Telegram keyboards/text, CLI args.
 * NEIGHBORS: src/cli.ts, src/commands.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";
import type { BotKind } from "./types.js";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

export const DEFAULT_EFFORT_LEVEL: EffortLevel = "medium";

const ENV_KEYS: Record<BotKind, string> = {
  codex: "CODEX_EFFORT",
  claude: "CLAUDE_EFFORT",
  antigravity: "ANTIGRAVITY_EFFORT",
  grok: "GROK_EFFORT",
  cursor: "CURSOR_EFFORT",
};

const agyEffortByArgs = new WeakMap<string[], EffortLevel>();

export function isEffortLevel(value: string | null | undefined): value is EffortLevel {
  return !!value && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function effortSettingKey(kind: BotKind): string {
  return `effort:${kind}`;
}

export function normalizeEffort(value: string | null | undefined): EffortLevel {
  const raw = String(value || "").trim().toLowerCase();
  return isEffortLevel(raw) ? raw : DEFAULT_EFFORT_LEVEL;
}

export function resolveDefaultEffort(kind: BotKind, env: NodeJS.ProcessEnv = process.env): EffortLevel {
  return normalizeEffort(env[ENV_KEYS[kind]]);
}

export function resolveEffort(kind: BotKind, db: Pick<BridgeDb, "getSetting">, env: NodeJS.ProcessEnv = process.env): EffortLevel {
  return normalizeEffort(db.getSetting(effortSettingKey(kind)) || resolveDefaultEffort(kind, env));
}

export function buildEffortKeyboard(kind: BotKind, currentEffort: EffortLevel) {
  return {
    inline_keyboard: [
      EFFORT_LEVELS.map((level) => ({
        text: level === currentEffort ? `✓ ${level}` : level,
        callback_data: `effort:${kind}:${level}`,
      })),
      [{ text: "Reset to Default", callback_data: `effort:${kind}:reset` }],
    ],
  };
}

export function buildEffortText(kind: BotKind, currentEffort: EffortLevel): string {
  const support =
    kind === "codex" ? "Codex maps effort to model_reasoning_effort." :
    kind === "claude" ? "Claude maps effort to --effort." :
    kind === "grok" ? "Grok maps effort to the native headless --effort flag." :
    kind === "cursor" ? "Cursor effort is unsupported by the qualified headless contract; this setting is recorded for parity only." :
    "Agy maps effort to the selected Gemini model variant. Low/medium/high map directly; xhigh/max use high.";

  return [
    `Effort for ${kind}: ${currentEffort}`,
    `Default: ${DEFAULT_EFFORT_LEVEL}`,
    support,
  ].join("\n");
}

/**
 * Resolve Agent Bridge's provider-neutral effort setting to the concrete Agy
 * Gemini model slug. Model preference stays at the family level; Agy's
 * low/medium/high suffix is an execution setting, not a fallback model.
 */
export function resolveAgyModelForEffort(
  model: string | null,
  effort: EffortLevel | null | undefined,
): string | null {
  if (model === null) return null;
  const trimmed = model.trim();
  if (!/^gemini-/i.test(trimmed)) return trimmed;

  const explicitVariant = trimmed.match(/-(?:low|medium|high)$/i);
  if (effort == null && explicitVariant) return trimmed;

  const base = trimmed.replace(/-(?:low|medium|high)$/i, "");
  let variant: "low" | "medium" | "high" =
    effort === "low" ? "low" :
    effort === "high" || effort === "xhigh" || effort === "max" ? "high" :
    "medium";

  // The retained Gemini 3.1 Pro fallback exposes low/high but no medium.
  // Preserve the old fallback priority by using high for medium effort.
  if (base.toLowerCase() === "gemini-3.1-pro" && variant === "medium") {
    variant = "high";
  }
  return `${base}-${variant}`;
}

/** Effort metadata follows the exact Agy args array into the serialized runner. */
export function getAgyEffortForArgs(args: string[]): EffortLevel | null {
  return agyEffortByArgs.get(args) ?? null;
}

export function appendEffortArgs(command: string, args: string[], effort: EffortLevel | null | undefined): string[] {
  if (!effort) return args;

  const cmdName = command.split(/[\\/]/).pop()?.toLowerCase() || command.toLowerCase();
  const isCodex = cmdName.includes("codex");
  const isClaude = cmdName.includes("claude");
  const isAgy = cmdName.includes("agy") || cmdName.includes("antigravity");

  if (isAgy) {
    // Agy has no separate effort flag. Carry the setting out-of-band so the
    // serialized runner can apply it to the selected model while holding the
    // provider-state lock, without leaking a synthetic CLI argument.
    agyEffortByArgs.set(args, effort);
    return args;
  }
  if (isClaude) {
    if (args.includes("--effort")) return args;
    return ["--effort", effort, ...args];
  }
  if (isCodex) {
    for (let i = 0; i < args.length - 1; i += 1) {
      if ((args[i] === "-c" || args[i] === "--config") && args[i + 1]?.startsWith("model_reasoning_effort=")) {
        return args;
      }
    }
    const next = [...args];
    const insertAt = next[0] === "exec" ? 1 : 0;
    next.splice(insertAt, 0, "-c", `model_reasoning_effort="${effort}"`);
    return next;
  }
  return args;
}
