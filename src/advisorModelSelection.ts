import type { AcpSessionConfigOptionSnapshot } from "./acp/sessionConfig.js";
import type { ProviderId } from "./providers/types.js";

/** Class selectors are explicit, not guessed from arbitrary configured model IDs. */
export function advisorModelClass(provider: ProviderId, configuredModel: string): "opus" | "sol" | null {
  if (provider === "claude" && configuredModel === "opus") return "opus";
  if (provider === "codex" && configuredModel === "sol") return "sol";
  return null;
}

function versionComponents(id: string, modelClass: "opus" | "sol"): number[] | null {
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const classIndex = tokens.indexOf(modelClass);
  if (classIndex < 0) return null;
  // Release dates such as 20261020 are not minor versions.
  const components = modelClass === "opus"
    ? tokens.slice(classIndex + 1, classIndex + 3)
    : (() => {
      const familyIndex = tokens.lastIndexOf("gpt", classIndex);
      return familyIndex < 0 || classIndex - familyIndex > 3
        ? []
        : tokens.slice(familyIndex + 1, classIndex);
    })();
  const major = components[0];
  if (!major || !/^\d{1,2}$/.test(major)) return null;
  const minor = components[1];
  return minor && /^\d{1,2}$/.test(minor)
    ? [Number(major), Number(minor)]
    : [Number(major)];
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
