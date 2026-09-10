/**
 * PURPOSE: Runtime readiness diagnostics (Epic 11, issue #53).
 * Checks provider executables, fallback-chain parseability, required env
 * entries, and lets the provider registry report available/missing status.
 * NEIGHBORS: src/providers/registry.ts, scripts in package.json ("doctor").
 */

import { execFileSync } from "node:child_process";
import { inspectVoiceRuntimeReadiness, type VoiceRuntimeReadiness } from "../voiceRuntimeReadiness.js";
import { resolveProviderRuntime } from "./acpRuntime.js";
import { getProviderAdapters } from "./registry.js";
import { interactiveChainKinds, parseCliChain } from "./selection.js";

/** CLI kinds accepted in bridge fallback chains (chain vocabulary, not provider ids). */
const KNOWN_CHAIN_KINDS = new Set(["codex", "claude", "antigravity", "grok", "cursor"]);

/** Chain vocabulary differs from registry ids only for Antigravity (`agy`). */
const CHAIN_KIND_TO_PROVIDER_ID: Readonly<Record<string, string>> = {
  codex: "codex",
  claude: "claude",
  antigravity: "agy",
  grok: "grok",
  cursor: "cursor",
};

const CHAIN_ENV_VARS = [
  "INTERACTIVE_CLI_CHAIN",
] as const;

export interface ProviderCheck {
  id: string;
  executable: string;
  status: "available" | "missing" | "invalid";
  runtime?: "legacy" | "acp";
  runtimeIdentity?: string;
  version?: string | null;
  reason?: string;
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
  voiceTranscription: VoiceRuntimeReadiness;
}

export function defaultCommandExists(executable: string): boolean {
  try {
    execFileSync("which", [executable], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function defaultInspectVersion(executable: string): string | null {
  try {
    const output = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output.slice(0, 120) || null;
  } catch {
    return null;
  }
}

export function runDoctor({
  env = process.env,
  requiredEnv = [],
  commandExists = defaultCommandExists,
  inspectVersion = defaultInspectVersion,
  inspectVoiceRuntime = inspectVoiceRuntimeReadiness,
}: {
  env?: Record<string, string | undefined>;
  requiredEnv?: string[];
  commandExists?: (executable: string) => boolean;
  inspectVersion?: (executable: string) => string | null;
  inspectVoiceRuntime?: (env: Record<string, string | undefined>) => VoiceRuntimeReadiness;
} = {}): DoctorReport {
  const providers: ProviderCheck[] = getProviderAdapters().map((adapter) => {
    const runtime = resolveProviderRuntime(adapter.id, env);
    const available = commandExists(runtime.executable);
    return {
      id: adapter.id,
      executable: runtime.executable,
      status: available ? "available" : "missing",
      ...(runtime.transport === "acp-stdio"
        ? {
          runtime: "acp" as const,
          runtimeIdentity: runtime.runtimeIdentity,
          ...(available ? { version: inspectVersion(runtime.executable) } : {}),
        }
        : {}),
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

  const voiceTranscription = inspectVoiceRuntime(env);
  const voiceOk = voiceTranscription.status === "ready"
    || voiceTranscription.reasonCode === "voice_transcription_disabled";
  const ok =
    providers.every((p) =>
      p.status === "invalid"
        ? false
        : p.status === "available" || !configuredProviderIds.has(p.id),
    ) &&
    chains.every((c) => c.ok) &&
    envChecks.every((e) => e.present) &&
    voiceOk;

  return { ok, providers, chains, env: envChecks, voiceTranscription };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const p of report.providers) {
    const runtime = p.runtime ? ` runtime=${p.runtime}` : "";
    const identity = p.runtimeIdentity ? ` identity=${p.runtimeIdentity}` : "";
    const version = p.version ? ` version=${p.version}` : "";
    const reason = p.reason ? ` (${p.reason})` : "";
    lines.push(`provider ${p.id} (${p.executable})${runtime}${identity}: ${p.status}${version}${reason}`);
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
  lines.push(`voice transcription: ${report.voiceTranscription.status}${report.voiceTranscription.reasonCode ? ` (${report.voiceTranscription.reasonCode})` : ""}`);
  lines.push(report.ok ? "doctor: ok" : "doctor: problems found");
  return lines.join("\n");
}
