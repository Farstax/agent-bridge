import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  abortCliProcessAndWait,
  runCli,
  runCliAsync,
  shutdownCliProcessesAndWait,
} from "../src/cli.js";
import { buildWorkspaceLockedInvocation } from "../src/workspaceLock.js";

const CRITICAL_SECTION = String.raw`
const fs = require("node:fs");
const [marker, overlap, events, id, holdMs] = process.argv.slice(1);
try {
  fs.mkdirSync(marker);
} catch (error) {
  if (error && error.code === "EEXIST") fs.appendFileSync(overlap, id + "\n");
  else throw error;
}
fs.appendFileSync(events, "start:" + id + "\n");
setTimeout(() => {
  fs.rmSync(marker, { recursive: true, force: true });
  fs.appendFileSync(events, "finish:" + id + "\n");
  process.stdout.write(id);
}, Number(holdMs));
`;

const WRITE_AND_WAIT = String.raw`
const fs = require("node:fs");
const [started] = process.argv.slice(1);
fs.writeFileSync(started, "started");
setTimeout(() => {}, 10_000);
`;

const WRITE_AND_RESIST_TERM = String.raw`
const fs = require("node:fs");
const [started] = process.argv.slice(1);
process.on("SIGTERM", () => {});
fs.writeFileSync(started, "started");
setTimeout(() => {}, 10_000);
`;

function initRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-workspace-lock-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Agent Bridge Test"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("OS-backed workspace execution lock", () => {
  const roots: string[] = [];
  const previousLockMode = process.env.BRIDGE_WORKSPACE_LOCK_MODE;

  afterAll(() => {
    if (previousLockMode === undefined) delete process.env.BRIDGE_WORKSPACE_LOCK_MODE;
    else process.env.BRIDGE_WORKSPACE_LOCK_MODE = previousLockMode;
  });

  afterEach(async () => {
    delete process.env.BRIDGE_WORKSPACE_LOCK_MODE;
    await shutdownCliProcessesAndWait();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("disables the workspace lock explicitly when configured", () => {
    const root = initRepository();
    roots.push(root);
    process.env.BRIDGE_WORKSPACE_LOCK_MODE = "off";

    const invocation = buildWorkspaceLockedInvocation("node", ["-e", ""], root);

    expect(invocation.command).toBe("node");
    expect(invocation.args).toEqual(["-e", ""]);
    expect(invocation.workspaceLock).toBeNull();
  });

  it("keeps workspace locking enabled by default for ordinary executions", () => {
    const root = initRepository();
    roots.push(root);
    delete process.env.BRIDGE_WORKSPACE_LOCK_MODE;

    const invocation = buildWorkspaceLockedInvocation("node", ["-e", ""], root);

    expect(invocation.command).toMatch(/flock$/);
    expect(invocation.args[0]).toBe("--exclusive");
    expect(invocation.workspaceLock?.worktreeRoot).toBe(root);
  });

  it("serializes separate supervised runs in the same canonical worktree", async () => {
    const root = initRepository();
    roots.push(root);
    const state = mkdtempSync(join(tmpdir(), "agent-bridge-workspace-state-"));
    roots.push(state);
    const marker = join(state, "active");
    const overlap = join(state, "overlap");
    const events = join(state, "events");
    const nested = join(root, "nested", "path");
    mkdirSync(nested, { recursive: true });

    const first = runCli(process.execPath, ["-e", CRITICAL_SECTION, marker, overlap, events, "first", "250"], root, {
      chatId: "workspace-lock-first",
    });
    await waitForFile(events);
    const second = runCliAsync(process.execPath, ["-e", CRITICAL_SECTION, marker, overlap, events, "second", "25"], nested, {
      chatId: "workspace-lock-second",
    });

    await Promise.all([first, second]);
    expect(existsSync(overlap)).toBe(false);
    expect(readFileSync(events, "utf8").trim().split("\n")).toEqual([
      "start:first",
      "finish:first",
      "start:second",
      "finish:second",
    ]);
  });

  it("bypassWorkspaceLock: true skips the flock wrapper entirely", () => {
    const root = initRepository();
    roots.push(root);
    delete process.env.BRIDGE_WORKSPACE_LOCK_MODE;

    const invocation = buildWorkspaceLockedInvocation("node", ["-e", ""], root, { bypassWorkspaceLock: true });

    expect(invocation.command).toBe("node");
    expect(invocation.args).toEqual(["-e", ""]);
    expect(invocation.workspaceLock).toBeNull();
  });

  it("a bypassWorkspaceLock run executes concurrently with an active workspace-locked run instead of serializing (Issue #177 /btw)", async () => {
    const root = initRepository();
    roots.push(root);
    const state = mkdtempSync(join(tmpdir(), "agent-bridge-workspace-state-"));
    roots.push(state);
    const marker = join(state, "active");
    const overlap = join(state, "overlap");
    const events = join(state, "events");

    const first = runCli(process.execPath, ["-e", CRITICAL_SECTION, marker, overlap, events, "first", "250"], root, {
      chatId: "workspace-lock-btw-holder",
    });
    await waitForFile(events);
    const second = runCliAsync(process.execPath, ["-e", CRITICAL_SECTION, marker, overlap, events, "second", "25"], root, {
      chatId: "workspace-lock-btw-side",
      bypassWorkspaceLock: true,
    });

    await Promise.all([first, second]);
    // The bypassing run entered the critical section WHILE "first" still held
    // it — proven by the overlap marker the fixture writes on EEXIST.
    expect(existsSync(overlap)).toBe(true);
  });

  it("allows runs in distinct linked worktrees to execute concurrently", async () => {
    const root = initRepository();
    roots.push(root);
    const linked = `${root}-linked`;
    roots.push(linked);
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "linked-test", linked]);
    const state = mkdtempSync(join(tmpdir(), "agent-bridge-workspace-state-"));
    roots.push(state);
    const marker = join(state, "active");
    const overlap = join(state, "overlap");
    const events = join(state, "events");

    const first = runCli(process.execPath, ["-e", CRITICAL_SECTION, marker, overlap, events, "first", "250"], root);
    await waitForFile(events);
    const second = runCliAsync(process.execPath, ["-e", CRITICAL_SECTION, marker, overlap, events, "second", "25"], linked);

    await Promise.all([first, second]);
    expect(readFileSync(overlap, "utf8")).toContain("second");
  });

  it("cancels a supervised waiter before its CLI enters the worktree", async () => {
    const root = initRepository();
    roots.push(root);
    const holderStarted = join(root, ".holder-started");
    const waiterStarted = join(root, ".waiter-started");

    const holder = runCliAsync(process.execPath, ["-e", WRITE_AND_WAIT, holderStarted], root, {
      chatId: "workspace-lock-holder",
      killGraceMs: 25,
    });
    await waitForFile(holderStarted);
    const waiter = runCliAsync(process.execPath, ["-e", WRITE_AND_WAIT, waiterStarted], root, {
      chatId: "workspace-lock-waiter",
      killGraceMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(abortCliProcessAndWait("workspace-lock-waiter")).resolves.toBe(true);
    await expect(waiter).resolves.toMatchObject({ text: "" });
    expect(existsSync(waiterStarted)).toBe(false);

    await abortCliProcessAndWait("workspace-lock-holder");
    await holder;
  }, 8_000);

  it("times out a supervised waiter before its CLI enters the worktree", async () => {
    const root = initRepository();
    roots.push(root);
    const holderStarted = join(root, ".holder-started");
    const waiterStarted = join(root, ".waiter-started");

    const holder = runCliAsync(process.execPath, ["-e", WRITE_AND_WAIT, holderStarted], root, {
      chatId: "workspace-lock-timeout-holder",
      killGraceMs: 25,
    });
    await waitForFile(holderStarted);
    const waiter = runCliAsync(process.execPath, ["-e", WRITE_AND_WAIT, waiterStarted], root, {
      chatId: "workspace-lock-timeout-waiter",
      timeoutMs: 75,
      killGraceMs: 25,
    });

    await expect(waiter).rejects.toThrow(/hard timeout/i);
    expect(existsSync(waiterStarted)).toBe(false);
    await abortCliProcessAndWait("workspace-lock-timeout-holder");
    await holder;
  }, 8_000);

  it("releases the worktree lock after a TERM-resistant holder is killed", async () => {
    const root = initRepository();
    roots.push(root);
    const holderStarted = join(root, ".holder-started");

    const holder = runCliAsync(process.execPath, ["-e", WRITE_AND_RESIST_TERM, holderStarted], root, {
      chatId: "workspace-lock-killed-holder",
      timeoutMs: 150,
      killGraceMs: 25,
    });
    await waitForFile(holderStarted);
    const waiter = runCli(process.execPath, ["-e", "process.stdout.write('acquired')"], root, {
      chatId: "workspace-lock-after-crash",
      timeoutMs: 2_000,
    });

    await expect(holder).rejects.toThrow(/hard timeout/i);
    await expect(waiter).resolves.toBe("acquired");
  }, 8_000);
});
