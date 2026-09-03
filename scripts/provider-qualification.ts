#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  qualifyProvider,
  qualifyProviderIfNeeded,
  qualificationEvidencePath,
} from "../src/providers/qualification.js";
import {
  applyQualificationEntrypointEnvironment,
  resolveQualificationEntrypointEnvironment,
} from "../src/providers/qualificationEntrypoint.js";
import { assertProviderId, resolveProviderExecutable } from "../src/providers/registry.js";

interface Args {
  provider: string;
  expectedVersion?: string;
  previousVersion?: string;
  evidencePath?: string;
  bridgeCommit?: string;
  runtimeEnvDir?: string;
  ifNeeded: boolean;
  printEnv: boolean;
}

function parseArgs(argv: string[]): Args {
  let provider = "";
  let expectedVersion: string | undefined;
  let previousVersion: string | undefined;
  let evidencePath: string | undefined;
  let bridgeCommit: string | undefined;
  let runtimeEnvDir: string | undefined;
  let ifNeeded = false;
  let printEnv = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") provider = argv[++index] ?? "";
    else if (arg === "--expected-version") expectedVersion = argv[++index];
    else if (arg === "--previous-version") previousVersion = argv[++index];
    else if (arg === "--evidence") evidencePath = argv[++index];
    else if (arg === "--bridge-commit") bridgeCommit = argv[++index];
    else if (arg === "--runtime-env-dir") runtimeEnvDir = argv[++index];
    else if (arg === "--if-needed") ifNeeded = true;
    else if (arg === "--print-env") printEnv = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!provider) throw new Error("--provider is required");
  return { provider, expectedVersion, previousVersion, evidencePath, bridgeCommit, runtimeEnvDir, ifNeeded, printEnv };
}

function resolveBridgeCommit(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const configured = process.env.AGENT_BRIDGE_COMMIT
    ?? process.env.BRIDGE_COMMIT
    ?? process.env.BRIDGE_RELEASE_COMMIT;
  if (configured?.trim()) return configured.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.env.BRIDGE_PROJECT_DIR ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const providerId = assertProviderId(args.provider);
  const runtimeEnv = resolveQualificationEntrypointEnvironment(providerId, {
    directory: args.runtimeEnvDir,
  });

  // A privileged caller (upgrade.sh running as root) can read the root-owned
  // service files this process cannot read once it drops to the unprivileged
  // target user for provider auth. --print-env lets that privileged caller
  // resolve the effective policy once and forward it explicitly, rather than
  // relying on this process re-deriving it from files it may not be able to
  // read (see resolveQualificationEntrypointEnvironment's EACCES fallback).
  if (args.printEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (value === undefined) continue;
      if (value.includes("\n")) throw new Error(`refusing to print multi-line env value for ${key}`);
      process.stdout.write(`${key}=${value}\n`);
    }
    return;
  }

  applyQualificationEntrypointEnvironment(runtimeEnv);

  const common = {
    providerId,
    executable: resolveProviderExecutable(providerId, runtimeEnv),
    evidencePath: args.evidencePath ?? qualificationEvidencePath(homedir()),
    previousVersion: args.previousVersion ?? null,
    bridgeCommit: resolveBridgeCommit(args.bridgeCommit),
    env: runtimeEnv,
  };

  const result = args.ifNeeded && args.expectedVersion
    ? await qualifyProviderIfNeeded({ ...common, installedVersion: args.expectedVersion })
    : { record: await qualifyProvider({ ...common, expectedVersion: args.expectedVersion }), ran: true };

  process.stdout.write(`${JSON.stringify({ ran: result.ran, ...result.record })}\n`);
  if (result.record.overall === "fail") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
