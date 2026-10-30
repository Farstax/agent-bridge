import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLockedAcpRegistryEntry } from "../src/providers/acpRegistry.js";
import type { ProviderId } from "../src/providers/types.js";

const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error("usage: exportAcpRegistry.ts --output FILE");
}

const providers: Partial<Record<ProviderId, ReturnType<typeof getLockedAcpRegistryEntry>>> = {};
for (const provider of ["agy", "cursor"] as const) {
  const entry = getLockedAcpRegistryEntry(provider);
  if (!entry) throw new Error(`release-locked ACP registry entry is missing: ${provider}`);
  providers[provider] = entry;
}

const output = resolve(process.argv[outputIndex + 1]);
writeFileSync(output, `${JSON.stringify({ schema_version: 1, providers }, null, 2)}\n`, { mode: 0o644 });
