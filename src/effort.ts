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
  kimchi: "KIMCHI_EFFORT",
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
    kind === "kimchi" ? "Kimchi maps effort to --thinking level." :
    "Agy effort is unsupported by the CLI; this setting is recorded for parity only. Use Agy model labels for low/high variants.";

  return [
    `Effort for ${kind}: ${currentEffort}`,
    `Default: ${DEFAULT_EFFORT_LEVEL}`,
    support,
  ].join("\n");
}

export function appendEffortArgs(command: string, args: string[], effort: EffortLevel | null | undefined): string[] {
  if (!effort) return args;

  const cmdName = command.split(/[\\/]/).pop()?.toLowerCase() || command.toLowerCase();
  const isCodex = cmdName.includes("codex");
  const isClaude = cmdName.includes("claude");
  const isKimchi = cmdName.includes("kimchi");
  const isAgy = cmdName.includes("agy") || cmdName.includes("antigravity");

  if (isAgy) return args;
  if (isKimchi) {
    // kimchi uses --thinking <level> (same scale as effort levels)
    if (args.includes("--thinking")) return args;
    return ["--thinking", effort, ...args];
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
