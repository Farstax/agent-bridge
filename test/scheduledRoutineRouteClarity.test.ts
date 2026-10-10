import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { describeScheduledRoutineRoute } from "../src/scheduledRoutines.js";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function helper(surfaceIdentity: string, args: string[], dbPath: string): string {
  return execFileSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/agent-bridge-routines.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BRIDGE_CONTEXT_DB: dbPath,
      AGENT_BRIDGE_SURFACE_IDENTITY: surfaceIdentity,
      AGENT_BRIDGE_CHAT_KEY: "-100:42",
      AGENT_BRIDGE_OWNER_KEY: "owner:test",
    },
  });
}

describe("scheduled routine route descriptor (#947)", () => {
  it("states that a dedicated provider conversation has no cross-provider fallback", () => {
    for (const provider of ["claude", "codex", "antigravity", "grok"]) {
      const text = describeScheduledRoutineRoute(`telegram:${provider}`);
      expect(text).toContain(`provider-locked to ${provider}`);
      expect(text).toMatch(/no cross-provider fallback/i);
    }
  });

  it("describes the unified conversations as capable of fallback without guaranteeing it", () => {
    for (const surface of ["telegram:interactive", "discord:interactive"]) {
      const text = describeScheduledRoutineRoute(surface);
      expect(text).toMatch(/unified/i);
      expect(text).toMatch(/not guaranteed/i);
      expect(text).not.toMatch(/provider-locked/);
    }
  });

  it("asserts nothing for an unrecognised surface", () => {
    expect(describeScheduledRoutineRoute("slack:acme")).toMatch(/not asserted/i);
  });
});

describe("agent-bridge-routines route output (#947)", () => {
  it("shows the route on create and list for a locked conversation without changing scoping", () => {
    const dbPath = join(tmpdir(), `routine-route-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(dbPath);
    openDb(dbPath, { serviceId: "route-test", runId: "route-run" }).close();

    const created = helper("telegram:claude", [
      "create", "--name", "Nightly", "--instruction", "Check things.", "--timezone", "Europe/London",
      "--weekly", "mon", "--time", "04:00",
    ], dbPath);
    expect(created).toMatch(/Created scheduled routine/);
    expect(created).toMatch(/provider-locked to claude/);
    expect(created).toMatch(/no cross-provider fallback/i);

    const listed = helper("telegram:claude", ["list"], dbPath);
    expect(listed).toMatch(/provider-locked to claude/);
    expect(listed).toContain("Nightly");

    const unified = helper("telegram:interactive", ["list"], dbPath);
    expect(unified).toMatch(/No scheduled routines/);
    expect(unified).toMatch(/unified/i);
    expect(readFileSync(dbPath).length).toBeGreaterThan(0);
  }, 30_000);
});
