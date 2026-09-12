export const ACP_PROVIDER_DEFAULT = "default";

export type AcpConfigCategory = "model" | "thought_level" | string;

export interface AcpSessionConfigValueOption {
  readonly value: string;
  readonly name?: string;
  readonly description?: string;
}

export interface AcpSessionConfigOptionSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: unknown;
  readonly options?: readonly AcpSessionConfigValueOption[];
}

export interface AcpSessionConfigIntent {
  readonly category: AcpConfigCategory;
  readonly explicitValue?: string | null;
  readonly preferredValues?: readonly string[];
  /** Required callers (for example Advisor provider:model targets) fail closed. */
  readonly required?: boolean;
}

export interface AcpSessionConfigSelection {
  readonly configId: string;
  readonly value: string;
  readonly category: string;
}

export interface AcpStaleSessionConfigValue {
  readonly category: string;
  readonly value: string;
}

export interface AcpSessionConfigPlan {
  readonly selections: readonly AcpSessionConfigSelection[];
  readonly stale: readonly AcpStaleSessionConfigValue[];
}

function advertisedValues(option: AcpSessionConfigOptionSnapshot): readonly string[] {
  return option.options?.map((candidate) => candidate.value) ?? [];
}

function findByCategory(
  configOptions: readonly AcpSessionConfigOptionSnapshot[],
  category: string,
): AcpSessionConfigOptionSnapshot | undefined {
  return configOptions.find((option) => option.type === "select" && option.category === category);
}

/**
 * Resolve Bridge policy onto the opaque values an ACP agent actually advertised.
 * Categories identify UX intent; config ids and values stay agent-owned.
 */
export function planAcpSessionConfig(
  configOptions: readonly AcpSessionConfigOptionSnapshot[],
  intents: readonly AcpSessionConfigIntent[],
): AcpSessionConfigPlan {
  const selections: AcpSessionConfigSelection[] = [];
  const stale: AcpStaleSessionConfigValue[] = [];

  for (const intent of intents) {
    const explicitValue = intent.explicitValue?.trim() || null;
    if (explicitValue === ACP_PROVIDER_DEFAULT) continue;

    const option = findByCategory(configOptions, intent.category);
    if (!option) {
      if (intent.required && explicitValue) {
        throw new Error(`ACP agent did not advertise required ${intent.category} session configuration`);
      }
      continue;
    }

    const values = advertisedValues(option);
    if (explicitValue) {
      if (!values.includes(explicitValue)) {
        if (intent.required) {
          throw new Error(
            `ACP ${intent.category} session configuration does not support value "${explicitValue}"`,
          );
        }
        stale.push({ category: intent.category, value: explicitValue });
        continue;
      }
      selections.push({ configId: option.id, value: explicitValue, category: intent.category });
      continue;
    }

    const preferred = (intent.preferredValues ?? []).find((value) => values.includes(value));
    if (preferred) {
      selections.push({ configId: option.id, value: preferred, category: intent.category });
    }
  }

  return { selections, stale };
}

function splitPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

export function acpModelPreference(
  providerId: string,
  env: Record<string, string | undefined>,
): readonly string[] {
  if (providerId === "claude") return splitPreference(env.CLAUDE_MODEL_PREFERENCE);
  if (providerId === "codex") return splitPreference(env.CODEX_MODEL_PREFERENCE);
  return [];
}

export function acpThoughtLevelPreference(
  providerId: string,
  env: Record<string, string | undefined>,
): readonly string[] {
  const raw = providerId === "claude"
    ? env.CLAUDE_EFFORT
    : providerId === "codex"
      ? env.CODEX_EFFORT
      : undefined;
  return raw?.trim() ? [raw.trim()] : [];
}

const providerDefaultIntents = new Set<string>();
const providerDefaultIntentKey = (providerId: string, category: string) => `${providerId}:${category}`;

/** Remember an explicit "Use provider default" choice that otherwise becomes null at legacy call boundaries. */
export function setAcpProviderDefaultIntent(
  providerId: string,
  category: string,
  enabled: boolean,
): void {
  const key = providerDefaultIntentKey(providerId, category);
  if (enabled) providerDefaultIntents.add(key);
  else providerDefaultIntents.delete(key);
}

export function hasAcpProviderDefaultIntent(providerId: string, category: string): boolean {
  return providerDefaultIntents.has(providerDefaultIntentKey(providerId, category));
}

/** Build provider-neutral semantic intents. No ACP config id or model translation lives here. */
export function acpSessionConfigIntents(
  providerId: string,
  request: {
    readonly model: string | null;
    readonly modelRequired?: boolean;
    readonly effort: string | null;
  },
  env: Record<string, string | undefined>,
): readonly AcpSessionConfigIntent[] {
  const intents: AcpSessionConfigIntent[] = [];
  const modelPreference = acpModelPreference(providerId, env);
  if (request.model || modelPreference.length > 0) {
    intents.push({
      category: "model",
      explicitValue: request.model,
      preferredValues: modelPreference,
      ...(request.modelRequired ? { required: true } : {}),
    });
  }

  const forceThoughtDefault = hasAcpProviderDefaultIntent(providerId, "thought_level");
  const thoughtPreference = forceThoughtDefault ? [] : acpThoughtLevelPreference(providerId, env);
  const effortIsOperatorPreference = Boolean(
    request.effort && thoughtPreference.length > 0 && thoughtPreference[0] === request.effort,
  );
  if (forceThoughtDefault || request.effort || thoughtPreference.length > 0) {
    intents.push({
      category: "thought_level",
      explicitValue: forceThoughtDefault
        ? ACP_PROVIDER_DEFAULT
        : effortIsOperatorPreference
          ? null
          : request.effort,
      preferredValues: thoughtPreference,
    });
  }
  return intents;
}

const snapshots = new Map<string, readonly AcpSessionConfigOptionSnapshot[]>();
const staleValues = new Map<string, readonly AcpStaleSessionConfigValue[]>();

function normalizeOption(value: AcpSessionConfigOptionSnapshot): AcpSessionConfigOptionSnapshot {
  return {
    id: value.id,
    ...(value.name ? { name: value.name } : {}),
    ...(value.description ? { description: value.description } : {}),
    ...(value.category ? { category: value.category } : {}),
    ...(value.type ? { type: value.type } : {}),
    ...(value.currentValue !== undefined ? { currentValue: value.currentValue } : {}),
    ...(value.options
      ? {
          options: value.options.map((option) => ({
            value: option.value,
            ...(option.name ? { name: option.name } : {}),
            ...(option.description ? { description: option.description } : {}),
          })),
        }
      : {}),
  };
}

export function replaceAcpSessionConfigSnapshot(
  providerId: string,
  configOptions: readonly AcpSessionConfigOptionSnapshot[],
  stale: readonly AcpStaleSessionConfigValue[] = [],
): void {
  snapshots.set(providerId, configOptions.map(normalizeOption));
  staleValues.set(providerId, stale.map((entry) => ({ ...entry })));
}

export function clearAcpSessionConfigSnapshot(providerId: string): void {
  snapshots.delete(providerId);
  staleValues.delete(providerId);
}

export function getAcpSessionConfigOption(
  providerId: string,
  category: string,
): AcpSessionConfigOptionSnapshot | null {
  return snapshots.get(providerId)?.find((option) => option.category === category && option.type === "select") ?? null;
}

export function isAcpSessionConfigValueStale(
  providerId: string,
  category: string,
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  return staleValues.get(providerId)?.some((entry) => entry.category === category && entry.value === value) ?? false;
}
