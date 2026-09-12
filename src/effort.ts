/**
 * PURPOSE: Standard effort-level config and CLI argument mapping.
 * INPUTS: Bot kind, BridgeDb settings and environment defaults.
 * OUTPUTS: Validated effort levels, Telegram keyboards/text, CLI args.
 * NEIGHBORS: src/cli.ts, src/commands.ts, src/engine.ts
 */

import {
  ACP_PROVIDER_DEFAULT,
  getAcpSessionConfigOption,
  hasAcpProviderDefaultIntent,
  setAcpProviderDefaultIntent,
} from "./acp/sessionConfig.js";
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

const ACP_EFFORT_KINDS = new Set<BotKind>(["codex", "claude"]);

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
  if (ACP_EFFORT_KINDS.has(kind)) {
    const advertised = getAcpSessionConfigOption(kind, "thought_level")?.currentValue;
    if (typeof advertised === "string" && isEffortLevel(advertised)) return advertised;
    const configured = env[ENV_KEYS[kind]]?.trim().toLowerCase();
    if (isEffortLevel(configured)) return configured;
  }
  return normalizeEffort(env[ENV_KEYS[kind]]);
}

export function resolveEffort(
  kind: BotKind,
  db: Pick<BridgeDb, "getSetting">,
  env: NodeJS.ProcessEnv = process.env,
): EffortLevel | null {
  const saved = db.getSetting(effortSettingKey(kind));
  if (ACP_EFFORT_KINDS.has(kind)) {
    const providerDefault = saved === ACP_PROVIDER_DEFAULT;
    setAcpProviderDefaultIntent(kind, "thought_level", providerDefault);
    if (providerDefault) return null;
    if (isEffortLevel(saved)) return saved;
    const configured = env[ENV_KEYS[kind]]?.trim().toLowerCase();
    return isEffortLevel(configured) ? configured : null;
  }
  return normalizeEffort(saved || resolveDefaultEffort(kind, env));
}

export function buildEffortKeyboard(kind: BotKind, currentEffort: EffortLevel | null) {
  if (ACP_EFFORT_KINDS.has(kind)) {
    const option = getAcpSessionConfigOption(kind, "thought_level");
    const candidates = (option?.options ?? []).filter((candidate) => isEffortLevel(candidate.value));
    const providerCurrent = typeof option?.currentValue === "string" && isEffortLevel(option.currentValue)
      ? option.currentValue
      : null;
    const providerDefault = hasAcpProviderDefaultIntent(kind, "thought_level");
    const selected = providerDefault ? null : currentEffort ?? providerCurrent;
    return {
      inline_keyboard: [
        ...(candidates.length > 0
          ? [candidates.map((candidate) => ({
              text: candidate.value === selected
                ? `✓ ${candidate.name ?? candidate.value}`
                : candidate.name ?? candidate.value,
              callback_data: `effort:${kind}:${candidate.value}`,
            }))]
          : []),
        [{
          text: providerDefault ? "✓ Use provider default" : "Use provider default",
          callback_data: `effort:${kind}:reset`,
        }],
      ],
    };
  }
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

export function buildEffortText(kind: BotKind, currentEffort: EffortLevel | null): string {
  if (ACP_EFFORT_KINDS.has(kind)) {
    const option = getAcpSessionConfigOption(kind, "thought_level");
    if (!option) {
      return [
        `Effort for ${kind}: provider-controlled`,
        "The live ACP session has not advertised a reasoning selector yet.",
      ].join("\n");
    }
    const providerDefault = hasAcpProviderDefaultIntent(kind, "thought_level");
    const providerCurrent = typeof option.currentValue === "string" ? option.currentValue : "provider default";
    const available = (option.options ?? [])
      .filter((candidate) => isEffortLevel(candidate.value))
      .map((candidate) => {
        const label = candidate.name && candidate.name !== candidate.value
          ? `${candidate.name} (${candidate.value})`
          : candidate.value;
        return candidate.description ? `${label}: ${candidate.description}` : label;
      });
    return [
      `Effort for ${kind}: ${providerDefault ? `provider default (${providerCurrent})` : currentEffort ?? providerCurrent}`,
      "Default: provider-controlled",
      option.description ?? "Available values come from the active ACP agent.",
      ...(available.length > 0 ? ["Available:", ...available.map((value) => `- ${value}`)] : []),
    ].join("\n");
  }

  const support =
    kind === "grok" ? "Grok maps effort to the native headless --effort flag." :
    kind === "cursor" ? "Cursor effort is unsupported by the qualified headless contract; this setting is recorded for parity only." :
    "A separate Agy effort CLI flag is unsupported; Agent Bridge maps effort to the selected Gemini model variant. Low/medium/high map directly; xhigh/max use high.";

  return [
    `Effort for ${kind}: ${currentEffort ?? DEFAULT_EFFORT_LEVEL}`,
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

  // Agy and Claude do not accept CLI effort flags. Claude configures effort
  // via ACP session configuration, and Antigravity resolves model family + effort before execution.
  if (isAgy || isClaude) return args;
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
