import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_ROLES } from "../src/db/schemaContract.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Engineering Worker removal boundary", () => {
  it("has no Worker runtime entrypoint or service", () => {
    expect(existsSync(resolve(root, "src/index-worker.ts"))).toBe(false);
    expect(existsSync(resolve(root, "systemd/agent-bridge-worker-bot.service"))).toBe(false);
    expect(read("scripts/releaseManifest.mjs")).not.toContain("src/index-worker.ts");
    expect(read("scripts/release-activate.py")).not.toContain("src/index-worker.ts");
  });

  it("keeps interactive execution on the ordinary provider fallback path", () => {
    expect(read("src/index-interactive.ts")).not.toContain("WORKER_CLI_CHAIN");
    expect(read("src/index-discord-interactive.ts")).not.toContain("WORKER_CLI_CHAIN");
    expect(read("src/interactiveBot.ts")).not.toContain("WorkerFallbackChain");
  });

  it("does not expose live work-job execution through BridgeDb", () => {
    const db = read("src/db.ts");
    expect(db).not.toContain("claimNextWorkJob");
    expect(db).not.toContain("createWorkJob");
    expect(db).not.toContain("recoverExpiredWorkJobs");
  });

  it("does not expose a Worker database role", () => {
    expect(DATABASE_ROLES).not.toContain("worker");
  });
});
