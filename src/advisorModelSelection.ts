import type { AcpSessionConfigOptionSnapshot } from "./acp/sessionConfig.js";
import type { ProviderId } from "./providers/types.js";

/** Class selectors are explicit, not guessed from arbitrary configured model IDs. */
export function advisorModelClass(provider: ProviderId, configuredModel: string): "opus" | "sol" | null {
  if (provider === "claude" && configuredModel === "opus") return "opus";
  if (provider === "codex" && configuredModel === "sol") return "sol";
  return null;
}

function versionComponents(id: string, modelClass: "opus" | "sol"): number[] | null {
  if (!new RegExp(`(?:^|[^a-z0-9])${modelClass}(?:$|[^a-z0-9])`, "i").test(id)) return null;
  const parts = id.match(/\\d+/g);
  if (!parts?.length) return null;
  const version = parts.map(Number);
  return version.every((part) => Number.isSafeInteger(part)) ? version : null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Never invent a provider model identifier. Ambiguous/unversioned matches use provider default. */
export function selectAdvisorClassModel(
  options: readonly AcpSessionConfigOptionSnapshot[],
  modelClass: "opus" | "sol",
): string | null {
  const model = options.find((option) => option.category === "model" && option.type === "select");
  let winner: { id: string; version: number[] } | null = null;
  let tied = false;
  for (const entry of model?.options ?? []) {
    const id = entry.value;
    const version = versionComponents(id, modelClass);
    if (!version) continue;
    if (!winner || compareVersions(version, winner.version) > 0) {
      winner = { id, version };
      tied = false;
    } else if (compareVersions(version, winner.version) === 0 && id !== winner.id) {
      tied = true;
    }
  }
  return winner && !tied ? winner.id : null;
}
