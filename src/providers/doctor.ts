/**
 * PURPOSE: Runtime readiness diagnostics (Epic 11, issue #53).
 * Checks provider executables, fallback-chain parseability, and required env
 * entries, and lets the provider registry report available/missing status.
 * NEIGHBORS: src/providers/registry.ts, scripts in package.json ("doctor").
 */

import { execFileSync } from "node:child_process";
import { getProviderAdapters, resolveProviderExecutable } from "./registry.js";
import { interactiveChainKinds, parseCliChain } from "./selection.js";

/** CLI kinds accepted in bridge fallback chains (chain vocabulary, not provider ids). */
const KNOWN_CHAIN_KINDS = new Set(["codex", "claude", "antigravity", "grok"]);

/** Chain vocabulary differs from registry ids only for Antigravity (`agy`). */
const CHAIN_KIND_TO_PROVIDER_ID: Readonly<Record<string, string>> = {
  codex: "codex",
  claude: "claude",
  antigravity: "agy",
  grok: "grok",
};

const CHAIN_ENV_VARS = [
  "INTERACTIVE_CLI_CHAIN",
] as const;

export interface ProviderCheck {
  id: string;
  executable: string;
  status: "available" | "missing";
}

export interface ChainCheck {
  name: string;
  set: boolean;
  ok: boolean;
  entries: string[];
  unknown: string[];
}

export interface EnvCheck {
  name: string;
  present: boolean;
}

export interface DoctorReport {
  ok: boolean;
  providers: ProviderCheck[];
  chains: ChainCheck[];
  env: EnvCheck[];
}

export function defaultCommandExists(executable: string): boolean {
  try {
    execFileSync("which", [executable], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function runDoctor({
  env = process.env,
  requiredEnv = [],
  commandExists = defaultCommandExists,
}: {
  env?: Record<string, string | undefined>;
  requiredEnv?: string[];
  commandExists?: (executable: string) => boolean;
} = {}): DoctorReport {
  const providers: ProviderCheck[] = getProviderAdapters().map((adapter) => {
    const executable = resolveProviderExecutable(adapter.id, env);
    return {
      id: adapter.id,
      executable,
      status: commandExists(executable) ? "available" : "missing",
    };
  });

  const effectiveEntries: Record<(typeof CHAIN_ENV_VARS)[number], string[]> = {
    INTERACTIVE_CLI_CHAIN: parseCliChain(
      env.INTERACTIVE_CLI_CHAIN,
      { allowed: interactiveChainKinds(), fallback: ["codex", "claude", "antigravity"] },
    ),
  };

  const chains: ChainCheck[] = CHAIN_ENV_VARS.map((name) => {
    const raw = env[name];
    if (raw == null || raw.trim() === "") {
      return { name, set: false, ok: true, entries: effectiveEntries[name], unknown: [] };
    }
    const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = entries.filter((e) => !KNOWN_CHAIN_KINDS.has(e));
    return { name, set: true, ok: entries.length > 0 && unknown.length === 0, entries, unknown };
  });

  const configuredProviderIds = new Set(
    chains.flatMap((chain) => chain.entries)
      .map((entry) => CHAIN_KIND_TO_PROVIDER_ID[entry])
      .filter((id): id is string => Boolean(id)),
  );

  const envChecks: EnvCheck[] = requiredEnv.map((name) => ({
    name,
    present: Boolean(env[name] && env[name] !== ""),
  }));

  const ok =
    providers.every((p) => p.status === "available" || !configuredProviderIds.has(p.id)) &&
    chains.every((c) => c.ok) &&
    envChecks.every((e) => e.present);

  return { ok, providers, chains, env: envChecks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const p of report.providers) {
    lines.push(`provider ${p.id} (${p.executable}): ${p.status}`);
  }
  for (const c of report.chains) {
    if (!c.set) {
      lines.push(`chain ${c.name}: not set (effective: ${c.entries.join(", ")})`);
    } else if (c.ok) {
      lines.push(`chain ${c.name}: ok [${c.entries.join(", ")}]`);
    } else {
      lines.push(`chain ${c.name}: INVALID (unknown: ${c.unknown.join(", ") || "empty"})`);
    }
  }
  for (const e of report.env) {
    lines.push(`env ${e.name}: ${e.present ? "present" : "MISSING"}`);
  }
  lines.push(report.ok ? "doctor: ok" : "doctor: problems found");
  return lines.join("\n");
}
