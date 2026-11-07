#!/usr/bin/env tsx
/**
 * Generic one-role admission entry point for a maintenance owner. Never probes
 * or mutates a missing database. The owner must carry the returned token across
 * its guarded operation and release it after successful activation or rollback.
 */
import { readIdleUpgradeState, releaseIdleUpgrade, tryAdmitIdleUpgrade } from "../src/idleUpgradeAdmission.js";

const args = process.argv.slice(2);
const action = args[0];
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = value("--db");
if (!dbPath || !["status", "acquire", "release"].includes(action ?? "")) {
  console.error("Usage: idle-maintenance <status|acquire|release> --db <existing-db> [--token <uuid>]");
  process.exit(2);
}
try {
  if (action === "status") {
    const state = readIdleUpgradeState(dbPath);
    console.log(JSON.stringify({ state }));
    if (state === "unknown") process.exitCode = 2;
  } else if (action === "acquire") {
    const result = tryAdmitIdleUpgrade(dbPath);
    console.log(JSON.stringify(result));
    if (result.state === "unknown") process.exitCode = 2;
  } else {
    const token = value("--token");
    if (!token || !/^[0-9a-f-]{36}$/.test(token)) throw new Error("an exact owner token is required");
    const released = releaseIdleUpgrade(dbPath, token);
    console.log(JSON.stringify({ released }));
    if (!released) process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
