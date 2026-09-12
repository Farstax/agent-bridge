/**
 * PURPOSE: Standard effort-level config and CLI argument mapping.
 * INPUTS: Bot kind, BridgeDb settings and environment defaults.
 * OUTPUTS: Validated effort levels, Telegram keyboards/text, CLI args.
 * NEIGHBORS: src/cli.ts, src/commands.ts, src/engine.ts
 */

import {
  getAcpSessionConfigOption,
  hasAcpProviderDefaultIntent,
  isAcpProviderDefaultSelected,
} from "./acp/sessionConfig.js";
import type { BridgeDb } from "./db.js";
import type { BotKind } from "./types.js";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type BridgeEffortLevel = typeof EFFORT_LEVELS[number];
/**
 * ACP-backed providers own their thought-level value vocabulary, so an effort
 * value is intentionally an opaque string at the provider boundary. Native
 * Bridge-managed providers are still normalized against EFFORT_LEVELS.
 */
export type EffortLevel = string;
type AgyEffortVariant = "low" | "medium" | "high";

export const DEFAULT_EFFORT_LEVEL: BridgeEffortLevel = "medium";

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

function isBridgeEffortLevel(value: string | null | undefined): value is BridgeEffortLevel {
  return !!value && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isAdvertisedAcpEffortValue(value: string | null | undefined): value is string {
  if (!value) return false;
  for (const kind of ACP_EFFORT_KINDS) {
    const option = getAcpSessionConfigOption(kind, "thought_level");
    if (option?.options?.some((candidate) => candidate.value === value)) return true;
  }
  return false;
}

/**
 * True for Bridge-native effort levels or an opaque thought-level value that a
 * live ACP provider actually advertised. This keeps Telegram callback
 * validation provider-authoritative without inventing ACP values in Bridge.
 */
export function isEffortLevel(value: string | null | undefined): value is EffortLevel {
  return isBridgeEffortLevel(value) || isAdvertisedAcpEffortValue(value);
}

export function effortSettingKey(kind: BotKind): string {
  return `effort:${kind}`;
}

export function normalizeEffort(value: string | null | undefined): BridgeEffortLevel {
  const raw = String(value || "").trim().toLowerCase();
  return isBridgeEffortLevel(raw) ? raw : DEFAULT_EFFORT_LEVEL;
}

export function resolveDefaultEffort(kind: BotKind, env: NodeJS.ProcessEnv = process.env): EffortLevel {
  if (ACP_EFFORT_KINDS.has(kind)) {
    const advertised = getAcpSessionConfigOption(kind, "thought_level")?.currentValue;
    if (typeof advertised === "string" && advertised.trim()) return advertised;
    const configured = env[ENV_KEYS[kind]]?.trim();
    if (configured) return configured;
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
    if (isAcpProviderDefaultSelected(db, kind, "thought_level")) return null;
    if (saved?.trim()) return saved.trim();
    const configured = env[ENV_KEYS[kind]]?.trim();
    return configured || null;
  }
  return normalizeEffort(saved || resolveDefaultEffort(kind, env));
}

export function buildEffortKeyboard(
  kind: BotKind,
  currentEffort: EffortLevel | null,
  providerDefaultSelected = ACP_EFFORT_KINDS.has(kind) && hasAcpProviderDefaultIntent(kind, "thought_level"),
) {
  if (ACP_EFFORT_KINDS.has(kind)) {
    const option = getAcpSessionConfigOption(kind, "thought_level");
    const candidates = option?.options ?? [];
    const providerCurrent = typeof option?.currentValue === "string"
      ? option.currentValue
      : null;
    const selected = providerDefaultSelected ? null : currentEffort ?? providerCurrent;
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
          text: providerDefaultSelected ? "✓ Use provider default" : "Use provider default",
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

export function buildEffortText(
  kind: BotKind,
  currentEffort: EffortLevel | null,
  providerDefaultSelected = ACP_EFFORT_KINDS.has(kind) && hasAcpProviderDefaultIntent(kind, "thought_level"),
): string {
  if (ACP_EFFORT_KINDS.has(kind)) {
    const option = getAcpSessionConfigOption(kind, "thought_level");
    if (!option) {
      return [
        `Effort for ${kind}: provider-controlled`,
        "The live ACP session has not advertised a reasoning selector yet.",
      ].join("\n");
    }
    const providerCurrent = typeof option.currentValue === "string" ? option.currentValue : "provider default";
    const available = (option.options ?? [])
      .map((candidate) => {
        const label = candidate.name && candidate.name !== candidate.value
          ? `${candidate.name} (${candidate.value})`
          : candidate.value;
        return candidate.description ? `${label}: ${candidate.description}` : label;
      });
    return [
      `Effort for ${kind}: ${providerDefaultSelected ? `provider default (${providerCurrent})` : currentEffort ?? providerCurrent}`,
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
  const normalizedEffort = isBridgeEffortLevel(effort) ? effort : null;
  if (normalizedEffort == null && explicitVariant) return `${family}-${explicitVariant}`;

  let desired: AgyEffortVariant =
    normalizedEffort === "low" ? "low" :
    normalizedEffort === "high" || normalizedEffort === "xhigh" || normalizedEffort === "max" ? "high" :
    "medium";

  if (!variants.includes(desired)) {
    desired = variants.includes("high") ? "high" : variants[0];
  }
  return `${family}-${desired}`;
}

export function appendEffortArgs(command: string, args: string[], effort: EffortLevel | null | undefined): string[] {
  if (!isBridgeEffortLevel(effort)) return args;

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
