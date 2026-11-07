#!/usr/bin/env tsx
/**
 * Generic admission boundary for an existing maintenance owner, not a deployer.
 * Pass every existing Bridge role before service containment. The caller must
 * supply its own LIVE PID; this short-lived CLI must not own a durable fence.
 * A deferred/unknown outcome never authorises a service stop.
 */
import {
  readIdleUpgradeRolesState, releaseIdleUpgrade, tryAdmitIdleUpgradeRoles,
} from "../src/idleUpgradeAdmission.js";

const args = process.argv.slice(2);
const action = args[0];
function values(flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && index + 1 < args.length) result.push(args[++index]);
  }
  return result;
}
const dbPaths = values("--db");
if (dbPaths.length === 0 || !["status", "acquire", "release"].includes(action ?? "")) {
  console.error("Usage: idle-maintenance <status|acquire|release> --db <existing-db> [--db <next-db> ...] [--owner-pid <live-maintenance-pid> (acquire)] [--token <exact-token> ... (release)]");
  process.exit(2);
}
try {
  if (action === "status") {
    const state = readIdleUpgradeRolesState(dbPaths);
    console.log(JSON.stringify({ state }));
    if (state !== "idle") process.exitCode = state === "deferred_busy" ? 75 : 2;
  } else if (action === "acquire") {
    const rawOwner = values("--owner-pid");
    if (rawOwner.length !== 1 || !/^[1-9]\d*$/.test(rawOwner[0])) throw new Error("live maintenance --owner-pid is required");
    const result = tryAdmitIdleUpgradeRoles(dbPaths, Number(rawOwner[0]));
    console.log(JSON.stringify(result));
    if (result.state !== "admitted") process.exitCode = result.state === "deferred_busy" ? 75 : 2;
  } else {
    const tokens = values("--token");
    if (dbPaths.length !== tokens.length || tokens.some((token) => !/^[0-9a-f-]{36}$/.test(token))) {
      throw new Error("one exact --token for each --db role is required");
    }
    // Attempt every release even if an earlier role cannot be released.
    let released = true;
    for (let index = 0; index < dbPaths.length; index++) {
      if (!releaseIdleUpgrade(dbPaths[index], tokens[index])) released = false;
    }
    console.log(JSON.stringify({ released }));
    if (!released) process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
