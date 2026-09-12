import { createHash } from "node:crypto";
import { getAcpSessionConfigOption } from "./sessionConfig.js";

export type AcpTelegramConfigCategory = "model" | "thought_level";

export interface AcpTelegramConfigCallbackResolution {
  readonly providerId: string;
  readonly category: AcpTelegramConfigCategory;
  readonly useProviderDefault: boolean;
  /** Null only when a value callback is stale/unknown in the current live catalogue. */
  readonly value: string | null;
}

const ACTIONS = {
  model: { value: "acpm", default: "acpmd" },
  thought_level: { value: "acpe", default: "acped" },
} as const;

const MAX_TELEGRAM_CALLBACK_BYTES = 64;

function valueToken(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Keep ACP option values opaque and out of Telegram callback_data. ACP does not
 * bound provider-owned values to Telegram's 64-byte callback limit, and no
 * literal value may double as a Bridge reset sentinel.
 */
export function buildAcpTelegramConfigCallbackData(
  providerId: string,
  category: AcpTelegramConfigCategory,
  value: string | null,
): string {
  const action = value === null ? ACTIONS[category].default : ACTIONS[category].value;
  const callbackData = value === null
    ? `${action}:${providerId}`
    : `${action}:${providerId}:${valueToken(value)}`;
  if (Buffer.byteLength(callbackData, "utf8") > MAX_TELEGRAM_CALLBACK_BYTES) {
    throw new Error(`ACP Telegram callback exceeds ${MAX_TELEGRAM_CALLBACK_BYTES} bytes for provider ${providerId}`);
  }
  return callbackData;
}

/**
 * Decode a Bridge-owned ACP Telegram callback. Value callbacks resolve only
 * against the selected provider/category's current live ACP catalogue. A
 * recognised callback with value=null and useProviderDefault=false is stale.
 */
export function resolveAcpTelegramConfigCallback(
  data: string,
): AcpTelegramConfigCallbackResolution | null {
  const [action, providerId, token, ...extra] = data.split(":");
  if (!providerId || extra.length > 0) return null;

  let category: AcpTelegramConfigCategory;
  let useProviderDefault: boolean;
  if (action === ACTIONS.model.value) {
    category = "model";
    useProviderDefault = false;
  } else if (action === ACTIONS.model.default) {
    category = "model";
    useProviderDefault = true;
  } else if (action === ACTIONS.thought_level.value) {
    category = "thought_level";
    useProviderDefault = false;
  } else if (action === ACTIONS.thought_level.default) {
    category = "thought_level";
    useProviderDefault = true;
  } else {
    return null;
  }

  if (useProviderDefault) {
    if (token !== undefined) return null;
    return { providerId, category, useProviderDefault: true, value: null };
  }
  if (!token) return null;

  const option = getAcpSessionConfigOption(providerId, category);
  const matchedValues = new Set(
    (option?.options ?? [])
      .filter((candidate) => valueToken(candidate.value) === token)
      .map((candidate) => candidate.value),
  );
  const value = matchedValues.size === 1 ? matchedValues.values().next().value ?? null : null;
  return { providerId, category, useProviderDefault: false, value };
}
