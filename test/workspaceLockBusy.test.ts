import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceLockBusyError,
  abortCliProcessAndWait,
  runSupervisedStdioSession,
  shutdownCliProcessesAndWait,
} from "../src/cli.js";
import {
  WORKSPACE_LOCK_CONFLICT_EXIT_CODE,
  buildWorkspaceLockedInvocation,
  resolveWorkspaceLockWaitSeconds,
} from "../src/workspaceLock.js";
import { decideProviderRecovery } from "../src/providers/recoveryVerdict.js";
import { runWithAcpTransientRetry } from "../src/providers/acpTransientRetry.js";

const HOLD = "process.stdout.write('ready\\n'); setTimeout(() => {}, 20000)";
const ONE_SHOT = "process.stdout.write('ran\\n'); setTimeout(() => process.exit(0), 50)";

function initRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-lock-busy-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  return root;
}

function firstChunk({ stdout, signal }: { stdout: NodeJS.ReadableStream; signal: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.once("data", (chunk) => resolve(String(chunk)));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("bounded worktree lock wait (Desk Workstream starvation)", () => {
  const roots: string[] = [];
  const holders: Array<() => void> = [];
  const repo = () => { const root = initRepository(); roots.push(root); return root; };
  const previous = process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS;
  const previousMode = process.env.BRIDGE_WORKSPACE_LOCK_MODE;

  beforeEach(() => { delete process.env.BRIDGE_WORKSPACE_LOCK_MODE; });

  afterEach(async () => {
    if (previousMode === undefined) delete process.env.BRIDGE_WORKSPACE_LOCK_MODE;
    else process.env.BRIDGE_WORKSPACE_LOCK_MODE = previousMode;
    if (previous === undefined) delete process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS;
    else process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS = previous;
    for (const release of holders.splice(0)) release();
    await shutdownCliProcessesAndWait();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Starts a long Run that holds the worktree lock until released. */
  async function hold(cwd: string, chatId: string): Promise<{ release: () => void; done: Promise<unknown> }> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const done = runSupervisedStdioSession(
      process.execPath, ["-e", HOLD], cwd,
      { bot: "codex", chatId, timeoutMs: 30_000, killGraceMs: 25 },
      async (io) => { await firstChunk(io); ready(); await released; },
    );
    done.catch(() => undefined);
    holders.push(release);
    await started;
    return { release, done };
  }

  it("parses the opt-in bound conservatively", () => {
    expect(resolveWorkspaceLockWaitSeconds({})).toBeNull();
    expect(resolveWorkspaceLockWaitSeconds({ BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS: "5" })).toBe(5);
    for (const bad of ["0", "-1", "abc", "301", ""]) {
      expect(resolveWorkspaceLockWaitSeconds({ BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS: bad })).toBeNull();
    }
  });

  it("keeps the historical unbounded wait unless a bound is requested", () => {
    const cwd = repo();
    const unbounded = buildWorkspaceLockedInvocation("provider", ["--acp"], cwd);
    expect(unbounded.args).not.toContain("--wait");
    const bounded = buildWorkspaceLockedInvocation("provider", ["--acp"], cwd, { waitSeconds: 2 });
    expect(bounded.args).toEqual(expect.arrayContaining(["--exclusive", "--no-fork", "--wait", "2", "--conflict-exit-code", String(WORKSPACE_LOCK_CONFLICT_EXIT_CODE)]));
    expect(bounded.workspaceLock).not.toBeNull();
  });

  it("reports a held worktree as busy within the bound and never starts the provider", async () => {
    const cwd = repo();
    await hold(cwd, "holder-1");
    process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS = "1";
    const started = Date.now();
    let outcome: unknown;
    try {
      await runSupervisedStdioSession(process.execPath, ["-e", ONE_SHOT], cwd,
        { bot: "codex", chatId: "waiter-1", timeoutMs: 30_000, killGraceMs: 25 }, firstChunk);
    } catch (error) { outcome = error; }
    expect(outcome).toBeInstanceOf(WorkspaceLockBusyError);
    expect(Date.now() - started).toBeLessThan(6_000);
    // Busy is neither provider quota nor a transport fault: no fallback, no capacity wait.
    const verdict = decideProviderRecovery("codex", outcome as Error);
    expect(verdict).toMatchObject({ reason: null, capacityExhausted: false, transportReason: null, authRequired: false });
  });

  it("lets independent worktrees run concurrently", async () => {
    const busy = repo();
    const other = repo();
    await hold(busy, "holder-2");
    process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS = "1";
    await expect(runSupervisedStdioSession(process.execPath, ["-e", ONE_SHOT], other,
      { bot: "codex", chatId: "other-1", timeoutMs: 30_000, killGraceMs: 25 }, firstChunk)).resolves.toBe("ran\n");
  });

  it("tolerates a brief hand-off from a Run that is just finishing", async () => {
    const cwd = repo();
    const holder = await hold(cwd, "holder-3");
    process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS = "5";
    const waiter = runSupervisedStdioSession(process.execPath, ["-e", ONE_SHOT], cwd,
      { bot: "codex", chatId: "waiter-3", timeoutMs: 30_000, killGraceMs: 25 }, firstChunk);
    setTimeout(holder.release, 300);
    await expect(waiter).resolves.toBe("ran\n");
  });

  it("keeps waiting without a bound and Stop cancels the waiter without a busy verdict", async () => {
    const cwd = repo();
    await hold(cwd, "holder-4");
    delete process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS;
    const waiter = runSupervisedStdioSession(process.execPath, ["-e", ONE_SHOT], cwd,
      { bot: "codex", chatId: "waiter-4", timeoutMs: 30_000, killGraceMs: 25 }, firstChunk);
    const settled = waiter.then(() => "resolved", (error) => error);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(Promise.race([settled, Promise.resolve("still-waiting")])).resolves.toBe("still-waiting");
    expect(await abortCliProcessAndWait("waiter-4")).toBe(true);
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WorkspaceLockBusyError);
  });

  it("does not mistake a provider's own exit status for the lock conflict", async () => {
    const cwd = repo();
    process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS = "1";
    let outcome: unknown;
    try {
      await runSupervisedStdioSession(process.execPath,
        ["-e", `process.stdout.write('hello\\n'); setTimeout(() => process.exit(${WORKSPACE_LOCK_CONFLICT_EXIT_CODE}), 100)`], cwd,
        { bot: "codex", chatId: "own-exit", timeoutMs: 30_000, killGraceMs: 25 },
        async ({ stdout }) => { await new Promise((resolve) => stdout.once("data", resolve)); await new Promise((resolve) => setTimeout(resolve, 400)); return "ok"; });
    } catch (error) { outcome = error; }
    expect(outcome).not.toBeInstanceOf(WorkspaceLockBusyError);
  });

  it("reports busy even when the ACP session rejects on stream close before the exit status arrives", async () => {
    const cwd = repo();
    await hold(cwd, "holder-5");
    process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS = "1";
    const closedStream = ({ stdout }: { stdout: NodeJS.ReadableStream }) => new Promise<never>((_resolve, reject) => {
      stdout.once("end", () => reject(new Error("ACP connection closed")));
      stdout.resume();
    });
    await expect(runSupervisedStdioSession(process.execPath, ["-e", ONE_SHOT], cwd,
      { bot: "codex", chatId: "waiter-5", timeoutMs: 30_000, killGraceMs: 25 }, closedStream)).rejects.toBeInstanceOf(WorkspaceLockBusyError);
  });

  it("does not report busy for a provider that exits with the conflict status on its own, immediately", async () => {
    const cwd = repo();
    process.env.BRIDGE_WORKSPACE_LOCK_WAIT_SECONDS = "3";
    const started = Date.now();
    const closedStream = ({ stdout }: { stdout: NodeJS.ReadableStream }) => new Promise<never>((_resolve, reject) => {
      stdout.once("end", () => reject(new Error("ACP connection closed")));
      stdout.resume();
    });
    let outcome: unknown;
    try {
      await runSupervisedStdioSession(process.execPath, ["-e", `process.exit(${WORKSPACE_LOCK_CONFLICT_EXIT_CODE})`], cwd,
        { bot: "codex", chatId: "own-exit-2", timeoutMs: 30_000, killGraceMs: 25 }, closedStream);
    } catch (error) { outcome = error; }
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(WorkspaceLockBusyError);
    expect(Date.now() - started).toBeLessThan(2_900);
  });

  it("does not retry a busy worktree, which would only wait another bound", async () => {
    let attempts = 0;
    await expect(runWithAcpTransientRetry("codex", async () => {
      attempts += 1;
      throw new WorkspaceLockBusyError();
    }, { abortRequested: () => false, promptSubmitted: () => false })).rejects.toBeInstanceOf(WorkspaceLockBusyError);
    expect(attempts).toBe(1);
  });
});
