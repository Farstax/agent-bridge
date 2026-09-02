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
}

function parseArgs(argv: string[]): Args {
  let provider = "";
  let expectedVersion: string | undefined;
  let previousVersion: string | undefined;
  let evidencePath: string | undefined;
  let bridgeCommit: string | undefined;
  let runtimeEnvDir: string | undefined;
  let ifNeeded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") provider = argv[++index] ?? "";
    else if (arg === "--expected-version") expectedVersion = argv[++index];
    else if (arg === "--previous-version") previousVersion = argv[++index];
    else if (arg === "--evidence") evidencePath = argv[++index];
    else if (arg === "--bridge-commit") bridgeCommit = argv[++index];
    else if (arg === "--runtime-env-dir") runtimeEnvDir = argv[++index];
    else if (arg === "--if-needed") ifNeeded = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!provider) throw new Error("--provider is required");
  return { provider, expectedVersion, previousVersion, evidencePath, bridgeCommit, runtimeEnvDir, ifNeeded };
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
