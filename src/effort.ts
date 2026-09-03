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
type AgyEffortVariant = "low" | "medium" | "high";

export const DEFAULT_EFFORT_LEVEL: EffortLevel = "medium";

const ENV_KEYS: Record<BotKind, string> = {
  codex: "CODEX_EFFORT",
  claude: "CLAUDE_EFFORT",
  antigravity: "ANTIGRAVITY_EFFORT",
  grok: "GROK_EFFORT",
  cursor: "CURSOR_EFFORT",
};

const AGY_GEMINI_EFFORT_VARIANTS: Readonly<Record<string, readonly AgyEffortVariant[]>> = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.5-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
};

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
    "A separate Agy effort CLI flag is unsupported; Agent Bridge maps effort to the selected Gemini model variant. Low/medium/high map directly; xhigh/max use high.";

  return [
    `Effort for ${kind}: ${currentEffort}`,
    `Default: ${DEFAULT_EFFORT_LEVEL}`,
    support,
  ].join("\n");
}

/** Collapse a known concrete Agy Gemini effort variant to its model family. */
export function normalizeAgyModelFamily(model: string): string {
  const trimmed = model.trim();
  const normalized = trimmed.toLowerCase();
  for (const [family, variants] of Object.entries(AGY_GEMINI_EFFORT_VARIANTS)) {
    if (normalized === family || variants.some((variant) => normalized === `${family}-${variant}`)) {
      return family;
    }
  }
  return trimmed;
}

/**
 * Resolve Agent Bridge's provider-neutral effort setting to the concrete Agy
 * Gemini model slug. Model preference stays at the family level; Agy's
 * low/medium/high suffix is an execution setting, not a fallback model.
 * Unknown Gemini families are preserved unchanged until their effort variants
 * are explicitly qualified here.
 */
export function resolveAgyModelForEffort(
  model: string | null | undefined,
  effort: EffortLevel | null | undefined,
): string | null {
  if (model == null) return null;
  const trimmed = model.trim();
  const family = normalizeAgyModelFamily(trimmed);
  const variants = AGY_GEMINI_EFFORT_VARIANTS[family.toLowerCase()];
  if (!variants) return trimmed;

  const explicitVariant = variants.find((variant) => trimmed.toLowerCase() === `${family}-${variant}`);
  if (effort == null && explicitVariant) return `${family}-${explicitVariant}`;

  let desired: AgyEffortVariant =
    effort === "low" ? "low" :
    effort === "high" || effort === "xhigh" || effort === "max" ? "high" :
    "medium";

  if (!variants.includes(desired)) {
    desired = variants.includes("high") ? "high" : variants[0];
  }
  return `${family}-${desired}`;
}

export function appendEffortArgs(command: string, args: string[], effort: EffortLevel | null | undefined): string[] {
  if (!effort) return args;

  const cmdName = command.split(/[\\/]/).pop()?.toLowerCase() || command.toLowerCase();
  const isCodex = cmdName.includes("codex");
  const isClaude = cmdName.includes("claude");
  const isAgy = cmdName.includes("agy") || cmdName.includes("antigravity");

  // Agy has no separate effort flag. The Antigravity invocation builder resolves
  // model family + effort before execution and keeps the CLI args native.
  if (isAgy) return args;
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
