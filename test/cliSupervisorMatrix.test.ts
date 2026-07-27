import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortCliProcess,
  abortCliProcessAndWait,
  getExecutionProcessState,
  runCli,
  runCliAsync,
  resolveSupervisorTimeouts,
  shutdownCliProcessesAndWait,
  abortExecutionAndWait,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  hasAbortCallback,
  buildCliInvocation,
  buildExecutionOptions,
  isChildRunning,
} from "../src/cli.js";
import type { BridgeEvent } from "../src/events/types.js";
import type { CliOptions } from "../src/types.js";

// Issue #135 Phase 2 — CLI supervisor consolidation.
// Locks in sync/async (runCli/runCliAsync) behavioural parity and the
// registry/cancellation race guarantees the shared internal supervisor must
// preserve exactly, per docs/implementation-plans/issue-135-code-cleanup.md
// section "PR 2 — unified CLI process supervision".

const cliTestCwd = mkdtempSync(join(tmpdir(), "agent-bridge-supervisor-matrix-"));

describe("supervisor timeout defaults", () => {
  it("disables hard and idle timeouts when callers omit options", () => {
    expect(resolveSupervisorTimeouts({})).toEqual({ timeoutMs: 0, idleTimeoutMs: null });
  });
});

describe("durable execution liveness", () => {
  it("detects a marked CLI process without relying on this process registry", async () => {
    const runId = `orphan-process-${Date.now()}-${Math.random()}`;
    const execution = runCli(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], cliTestCwd, {
      chatId: "liveness-test",
      eventContext: { runId, bot: "codex", chatId: "chat-1" },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getExecutionProcessState(runId)).toBe("live");
    } finally {
      await abortCliProcessAndWait("liveness-test");
      await execution.catch(() => undefined);
      expect(getExecutionProcessState(runId)).toBe("absent");
    }
  });
});

function initRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-supervisor-matrix-repo-"));
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

const roots: string[] = [];
const previousLockMode = process.env.BRIDGE_WORKSPACE_LOCK_MODE;

beforeEach(() => {
  // Enable workspace locking by default for tests in this file
  delete process.env.BRIDGE_WORKSPACE_LOCK_MODE;
});

afterEach(async () => {
  if (previousLockMode === undefined) delete process.env.BRIDGE_WORKSPACE_LOCK_MODE;
  else process.env.BRIDGE_WORKSPACE_LOCK_MODE = previousLockMode;
  await shutdownCliProcessesAndWait();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("1. env-scrub parity", () => {
  it("runCli and runCliAsync apply identical Telegram-secret and advisor-secret scrubbing", async () => {
    const envDump = "console.log(JSON.stringify(process.env))";
    const fakeEnv = {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "leaked-telegram-secret",
      TELEGRAM_ALLOWED_USER_IDS: "123,456",
      AGENT_BRIDGE_ADVISOR_CAPABILITY: "leaked-advisor-capability",
      BRIDGE_ADVISOR_ENABLED: "true",
      BRIDGE_ADVISOR_API_KEY: "leaked-advisor-key",
    };
    const previous = { ...process.env };
    Object.assign(process.env, fakeEnv);
    try {
      const [syncRaw, asyncRaw] = await Promise.all([
        runCli(process.execPath, ["-e", envDump], cliTestCwd, { advisorChild: true }),
        runCliAsync(process.execPath, ["-e", envDump], cliTestCwd, { advisorChild: true }),
      ]);
      const syncEnv = JSON.parse(syncRaw);
      const asyncEnv = JSON.parse((asyncRaw as { text: string }).text);

      for (const env of [syncEnv, asyncEnv]) {
        expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
        expect(env.TELEGRAM_ALLOWED_USER_IDS).toBeUndefined();
        expect(env.AGENT_BRIDGE_ADVISOR_CAPABILITY).toBeUndefined();
        expect(env.BRIDGE_ADVISOR_ENABLED).toBeUndefined();
        expect(env.BRIDGE_ADVISOR_API_KEY).toBeUndefined();
      }
      expect(Object.keys(syncEnv).sort()).toEqual(Object.keys(asyncEnv).sort());
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });
});

describe("2. Codex disabled-tool flag parity", () => {
  it("runCli and runCliAsync normalize --disable flags identically for a codex-named command", async () => {
    const echoArgv = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
    const codexScript = join(cliTestCwd, "codex");
    writeFileSync(codexScript, `#!/usr/bin/env node\n${echoArgv}\n`, { mode: 0o755 });

    const rawArgs = ["chat prompt", "--disable", "shell_tool", "--disable", "browser_use", "--json"];
    const [syncOut, asyncOut] = await Promise.all([
      runCli(codexScript, rawArgs, cliTestCwd),
      runCliAsync(codexScript, rawArgs, cliTestCwd),
    ]);
    const syncArgv = JSON.parse(syncOut);
    const asyncArgv = JSON.parse((asyncOut as { text: string }).text);

    expect(syncArgv).toEqual(asyncArgv);
    expect(syncArgv).toEqual(
      expect.arrayContaining(["--disable", "shell_tool", "--disable", "browser_use"]),
    );
  });
});

describe("3. idle-timeout parity", () => {
  it("runCli and runCliAsync both kill the full process group (including grandchildren) on idle timeout", async () => {
    async function assertGrandchildKilled(runner: typeof runCli | typeof runCliAsync, label: string) {
      const pidFile = join(cliTestCwd, `grandchild-${label}.pid`);
      const p = runner(
        "bash",
        ["-c", `sleep 30 & echo $! > ${pidFile}; wait`],
        cliTestCwd,
        { idleTimeoutMs: 300, timeoutMs: 10_000, killGraceMs: 150 },
      );
      await expect(p).rejects.toThrow(/idle timeout/i);
      await new Promise((r) => setTimeout(r, 400));
      const grandchildPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      expect(Number.isFinite(grandchildPid)).toBe(true);
      let alive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
      }
      if (alive) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch { /* cleanup */ }
      }
      expect(alive, `${label} grandchild should be dead after idle timeout`).toBe(false);
    }

    await assertGrandchildKilled(runCli, "sync");
    await assertGrandchildKilled(runCliAsync, "async");
  }, 15_000);
});

describe("4. Antigravity planner-stall parity", () => {
  it("runCli and runCliAsync both abort agy when planner churn persists without usable output", async () => {
    async function assertStallAborts(runner: typeof runCli | typeof runCliAsync, label: string) {
      const tempDir = mkdtempSync(join(tmpdir(), `agy-stall-parity-${label}-`));
      const scriptPath = join(tempDir, "agy");
      const logPath = join(tempDir, "agy.log");
      writeFileSync(
        scriptPath,
        `#!/usr/bin/env bash\necho 'PlannerResponse without ModifiedResponse encountered' > "$2"\nsleep 5\n`,
        { mode: 0o755 },
      );
      const previous = process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
      process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = "200";
      try {
        await expect(
          runner(scriptPath, ["--log-file", logPath, "--print", "hello"], cliTestCwd, {
            timeoutMs: 5_000,
            idleTimeoutMs: 5_000,
            killGraceMs: 25,
          }),
        ).rejects.toThrow(/stalled in planner loop/i);
      } finally {
        if (previous === undefined) delete process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
        else process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = previous;
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    await assertStallAborts(runCli, "sync");
    await assertStallAborts(runCliAsync, "async");
  }, 10_000);

  it("matches configured Agy wrapper commands and terminates the stalled child", async () => {
    async function assertWrapperAborts(runner: typeof runCli | typeof runCliAsync, label: string) {
      const tempDir = mkdtempSync(join(tmpdir(), `agy-wrapper-stall-${label}-`));
      const scriptPath = join(tempDir, "agy-wrapper");
      const logPath = join(tempDir, "agy.log");
      const pidPath = join(tempDir, "child.pid");
      writeFileSync(
        scriptPath,
        `#!/usr/bin/env bash\necho $$ > "${pidPath}"\necho 'PlannerResponse without ModifiedResponse encountered' > "$2"\nsleep 5\n`,
        { mode: 0o755 },
      );
      const previous = process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
      process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = "200";
      try {
        await expect(
          runner(scriptPath, ["--log-file", logPath, "--print", "hello"], cliTestCwd, {
            timeoutMs: 5_000,
            idleTimeoutMs: 5_000,
            killGraceMs: 25,
          }),
        ).rejects.toThrow(/stalled in planner loop/i);
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        expect(Number.isFinite(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        if (previous === undefined) delete process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
        else process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = previous;
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    await assertWrapperAborts(runCli, "sync");
    await assertWrapperAborts(runCliAsync, "async");
  }, 10_000);
});

describe("5. cancellation classification — no success event on abort", () => {
  it("runCli and runCliAsync emit run.cancelled, never run.completed, on user abort", async () => {
    async function assertCancelledNotCompleted(runner: typeof runCli | typeof runCliAsync, chatId: string) {
      const events: BridgeEvent[] = [];
      const started = join(cliTestCwd, `cancel-started-${chatId}`);
      const p = runner(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(started)}, "1"); setTimeout(() => {}, 10000)`], cliTestCwd, {
        chatId,
        eventContext: { runId: chatId, bot: "codex", chatId },
        onEvent: (e) => events.push(e),
      });
      await waitForFile(started);
      await expect(abortCliProcessAndWait(chatId)).resolves.toBe(true);
      await p;

      const types = events.map((e) => e.type);
      expect(types).toContain("run.cancelled");
      expect(types).not.toContain("run.completed");
    }

    await assertCancelledNotCompleted(runCli, "cancel-classify-sync");
    await assertCancelledNotCompleted(runCliAsync, "cancel-classify-async");
  }, 10_000);
});

describe("6. single-shot close/error settlement under races", () => {
  it("emits exactly one terminal lifecycle event when the hard timeout fires and the killed child closes shortly after, with no unhandled errors", async () => {
    // Promise.allSettled always reports "fulfilled" or "rejected" no matter
    // what happens internally — it cannot prove single settlement, and a
    // degenerate timeoutMs (e.g. 1ms) makes the "race" scheduler-dependent
    // rather than controlled. Instead: the child writes a ready marker, runs
    // with a generous timeoutMs, traps SIGTERM, and deliberately waits a
    // short but fixed delay before exiting once signalled. This makes the
    // sequence deterministic — hard-timeout fires first (pendingError set,
    // kill sent), the child's close arrives predictably ~30ms later — while
    // still exercising the exact pendingError-then-close ordering that a
    // double-settlement or double-emit bug would violate.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    const script = (ready: string) => [
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`,
      "process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 30); });",
      "setTimeout(() => {}, 10000);",
    ].join("\n");

    try {
      for (const runner of [runCli, runCliAsync] as const) {
        const label = runner === runCli ? "sync" : "async";
        for (let i = 0; i < 5; i++) {
          const ready = join(cliTestCwd, `race-ready-${label}-${i}`);
          const events: BridgeEvent[] = [];
          const chatId = `race-${label}-${i}`;
          const p = runner(process.execPath, ["-e", script(ready)], cliTestCwd, {
            timeoutMs: 200,
            killGraceMs: 1_000,
            chatId,
            eventContext: { runId: chatId, bot: "codex", chatId },
            onEvent: (e) => events.push(e),
          });
          await waitForFile(ready);
          await p.catch(() => "rejected");

          const terminal = events.filter((e) =>
            e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled",
          );
          expect(terminal, `${chatId} should emit exactly one terminal event, got: ${terminal.map((e) => e.type).join(",")}`).toHaveLength(1);
          expect(terminal[0].type).toBe("run.failed");
        }
      }
      // Give any stray timers/callbacks a tick to surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  }, 20_000);
});

describe("7. stale-child deregistration protection", () => {
  it("a late close from a displaced child does not clear a newer child's registration", async () => {
    const chatId = "stale-deregister-parity";
    const resistTerm = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], '1'); setTimeout(() => {}, 10000)";
    const firstStarted = join(cliTestCwd, "stale-first-started");
    const first = runCliAsync(process.execPath, ["-e", resistTerm, firstStarted], cliTestCwd, {
      chatId,
      timeoutMs: 150,
      killGraceMs: 400,
    });
    await waitForFile(firstStarted);

    // Time out the first child; it resists SIGTERM so its close event is delayed
    // behind killGraceMs. Before that close fires, register a second child under
    // the same chatId — the delayed close from the first must not deregister it.
    const firstOutcome = first.catch(() => "rejected" as const);

    const secondStarted = join(cliTestCwd, "stale-second-started");
    const second = runCli(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(secondStarted)}, '1'); setTimeout(() => {}, 10000)`], cliTestCwd, {
      chatId,
      killGraceMs: 25,
    });
    await waitForFile(secondStarted);

    await firstOutcome;
    // If the first child's late close wrongly cleared the registry entry for
    // chatId, abortCliProcess would find nothing to kill for the still-running
    // second child.
    expect(abortCliProcess(chatId)).toBe(true);
    await second.catch(() => "rejected");
  }, 10_000);
});

describe("8. shutdown waits for all children; no leaks", () => {
  it("shutdownCliProcessesAndWait terminates every tracked child across both runners and clears the registry", async () => {
    const started = [0, 1, 2, 3].map((i) => join(cliTestCwd, `shutdown-started-${i}`));
    const script = (marker: string) => `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); setTimeout(() => {}, 10000)`;

    const runs = [
      runCli(process.execPath, ["-e", script(started[0])], cliTestCwd, { chatId: "shutdown-sync-0", killGraceMs: 25 }),
      runCliAsync(process.execPath, ["-e", script(started[1])], cliTestCwd, { chatId: "shutdown-async-0", killGraceMs: 25 }),
      runCli(process.execPath, ["-e", script(started[2])], cliTestCwd, { chatId: "shutdown-sync-1", killGraceMs: 25 }),
      runCliAsync(process.execPath, ["-e", script(started[3])], cliTestCwd, { chatId: "shutdown-async-1", killGraceMs: 25 }),
    ];
    await Promise.all(started.map((m) => waitForFile(m)));

    const settlements = Promise.allSettled(runs);
    const count = await shutdownCliProcessesAndWait();
    expect(count).toBeGreaterThanOrEqual(4);
    await settlements;

    // shutdownCliProcessesAndWait must not return until every OS child is
    // actually dead — verify no leaked child_process handles remain by
    // confirming a fresh run for one of the same chatIds is not blocked.
    const followUp = await runCli(process.execPath, ["-e", "process.stdout.write('clean')"], cliTestCwd, {
      chatId: "shutdown-sync-0",
    });
    expect(followUp.trim()).toBe("clean");
  }, 10_000);
});

describe("9. Issue #133 lock holder/waiter stays in the same cancellation tree", () => {
  it("a runCli waiter blocked on the worktree lock is cancellable through the same abort path as runCliAsync", async () => {
    const root = initRepository();
    roots.push(root);
    const holderStarted = join(root, ".holder-started");
    const waiterStarted = join(root, ".waiter-started");
    const waitScript = "require('node:fs').writeFileSync(process.argv[1], 'started'); setTimeout(() => {}, 10000)";

    const holder = runCliAsync(process.execPath, ["-e", waitScript, holderStarted], root, {
      chatId: "lock-tree-holder",
      killGraceMs: 25,
    });
    await waitForFile(holderStarted);

    // The waiter is a runCli (sync) invocation this time, proving both entry
    // points share the identical registry + flock-wrapped cancellation path
    // that the existing runCliAsync-only waiter tests already cover.
    const waiter = runCli(process.execPath, ["-e", waitScript, waiterStarted], root, {
      chatId: "lock-tree-waiter",
      killGraceMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(abortCliProcessAndWait("lock-tree-waiter")).resolves.toBe(true);
    await expect(waiter).resolves.toBe("");
    expect(existsSync(waiterStarted)).toBe(false);

    await abortCliProcessAndWait("lock-tree-holder");
    await holder;
  }, 8_000);
});

describe("10. error-message truncation parity", () => {
  it("runCli truncates stdout in exit-code error messages the same way runCliAsync does", async () => {
    const bigOutput = "x".repeat(5_000);
    await expect(
      runCli(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(bigOutput)}); process.exit(1)`], cliTestCwd),
    ).rejects.toThrow(new RegExp(`CLI exited with code 1: x{2000}$`));
  });
});

describe("11. adapter-specific onProgress behaviour", () => {
  it("runCli never invokes onProgress even if a caller sets it on options", async () => {
    const onProgress = vi.fn();
    const options: CliOptions = { onProgress };
    await runCli(process.execPath, ["-e", "process.stdout.write('a'); process.stdout.write('b')"], cliTestCwd, options);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("runCliAsync invokes onProgress for each stdout chunk", async () => {
    const onProgress = vi.fn();
    await runCliAsync(process.execPath, ["-e", "process.stdout.write('a'); process.stdout.write('b')"], cliTestCwd, {
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
  });
});

describe("12. abort and shutdown wait for the full process tree, not just the leader", () => {
  // The leader spawns a non-detached descendant (inherits the leader's
  // process group) that traps and ignores SIGTERM, then the leader itself
  // exits immediately on SIGTERM (no trap). This makes "leader closed" and
  // "descendant dead" observably different instants: if the *AndWait APIs
  // only waited for the leader, the descendant would still be alive at the
  // moment the awaited promise resolves — checked with no buffer sleep.
  function leaderScript(descendantPidFile: string, readyFile: string): string {
    return [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const d = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},10000)"], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(d.pid));`,
      `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
      "setTimeout(() => {}, 10000);",
    ].join("\n");
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("abortCliProcessAndWait does not resolve until the TERM-resistant descendant is confirmed dead", async () => {
    const descendantPidFile = join(cliTestCwd, "abort-descendant.pid");
    const ready = join(cliTestCwd, "abort-leader-ready");
    const p = runCliAsync(process.execPath, ["-e", leaderScript(descendantPidFile, ready)], cliTestCwd, {
      chatId: "abort-tree",
      killGraceMs: 150,
    });
    await waitForFile(ready);
    await waitForFile(descendantPidFile);
    const descendantPid = parseInt(readFileSync(descendantPidFile, "utf8").trim(), 10);

    await expect(abortCliProcessAndWait("abort-tree")).resolves.toBe(true);
    // No buffer sleep here — the assertion runs the instant the await above
    // returns control, so it only passes if abortCliProcessAndWait itself
    // waited for the descendant, not merely the leader's own close.
    const alive = isAlive(descendantPid);
    if (alive) { try { process.kill(descendantPid, "SIGKILL"); } catch { /* cleanup */ } }
    expect(alive, "descendant should already be confirmed dead when abortCliProcessAndWait resolves").toBe(false);
    await p.catch(() => "rejected");
  }, 8_000);

  it("shutdownCliProcessesAndWait does not resolve until the TERM-resistant descendant is confirmed dead", async () => {
    const descendantPidFile = join(cliTestCwd, "shutdown-descendant.pid");
    const ready = join(cliTestCwd, "shutdown-leader-ready");
    const p = runCli(process.execPath, ["-e", leaderScript(descendantPidFile, ready)], cliTestCwd, {
      chatId: "shutdown-tree",
      killGraceMs: 150,
    });
    await waitForFile(ready);
    await waitForFile(descendantPidFile);
    const descendantPid = parseInt(readFileSync(descendantPidFile, "utf8").trim(), 10);

    await shutdownCliProcessesAndWait();
    const alive = isAlive(descendantPid);
    if (alive) { try { process.kill(descendantPid, "SIGKILL"); } catch { /* cleanup */ } }
    expect(alive, "descendant should already be confirmed dead when shutdownCliProcessesAndWait resolves").toBe(false);
    await p.catch(() => "rejected");
  }, 8_000);
});

describe("13. Antigravity DNS retry and cancellation behavior", () => {
  it("retries up to 3 times on transient DNS lookup failures for antigravity, emitting single outer started and failed events", async () => {
    const countFile = join(cliTestCwd, ".dns-retry-count");
    if (existsSync(countFile)) rmSync(countFile);

    const script = `
      const fs = require('node:fs');
      let count = 0;
      if (fs.existsSync('${countFile}')) {
        count = parseInt(fs.readFileSync('${countFile}', 'utf8'), 10);
      }
      fs.writeFileSync('${countFile}', String(count + 1));
      console.error('Error: Eligibility check failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: i/o timeout');
      process.exit(1);
    `;

    const events: BridgeEvent[] = [];
    const p = runCli(process.execPath, ["-e", script, "--", "--sandbox"], cliTestCwd, {
      chatId: "dns-retry-test-1",
      bot: "antigravity",
      eventContext: { runId: "test-run-1", bot: "antigravity", chatId: "dns-retry-test-1" },
      onEvent: (e) => events.push(e),
    });

    await expect(p).rejects.toThrow(/CLI exited with code 1/);
    expect(parseInt(readFileSync(countFile, "utf8"), 10)).toBe(3);

    // Verify exactly one started and one failed event
    const startEvents = events.filter((e) => e.type === "run.started");
    const failEvents = events.filter((e) => e.type === "run.failed");
    expect(startEvents.length).toBe(1);
    expect(failEvents.length).toBe(1);
  }, 10_000);

  it("recovers and succeeds on subsequent retry attempt, emitting one started and one completed event", async () => {
    const stateFile = join(cliTestCwd, ".retry-state");
    if (existsSync(stateFile)) rmSync(stateFile);

    const script = `
      const fs = require('node:fs');
      if (fs.existsSync('${stateFile}')) {
        console.log('{"response": "success output"}');
        process.exit(0);
      } else {
        fs.writeFileSync('${stateFile}', 'failed-once');
        console.error('Error: Eligibility check failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: i/o timeout');
        process.exit(1);
      }
    `;

    const events: BridgeEvent[] = [];
    const res = await runCli(process.execPath, ["-e", script, "--", "--sandbox"], cliTestCwd, {
      chatId: "dns-success-retry-test",
      bot: "antigravity",
      eventContext: { runId: "test-run-2", bot: "antigravity", chatId: "dns-success-retry-test" },
      onEvent: (e) => events.push(e),
    });

    expect(res).toContain("success output");

    // Verify exactly one started and one completed event, with no attempt terminal events (no failures)
    const startEvents = events.filter((e) => e.type === "run.started");
    const completedEvents = events.filter((e) => e.type === "run.completed");
    const failEvents = events.filter((e) => e.type === "run.failed");
    expect(startEvents.length).toBe(1);
    expect(completedEvents.length).toBe(1);
    expect(failEvents.length).toBe(0);
  }, 10_000);

  it("stops retrying and cancels backoff immediately when aborted via abortExecutionAndWait (production /stop), emitting exactly one started and one cancelled event", async () => {
    const cancelCountFile = join(cliTestCwd, ".dns-cancel-count");
    if (existsSync(cancelCountFile)) rmSync(cancelCountFile);

    const cancelScript = `
      const fs = require('node:fs');
      let count = 0;
      if (fs.existsSync('${cancelCountFile}')) {
        count = parseInt(fs.readFileSync('${cancelCountFile}', 'utf8'), 10);
      }
      fs.writeFileSync('${cancelCountFile}', String(count + 1));
      console.error('Error: Eligibility check failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: i/o timeout');
      process.exit(1);
    `;

    // We must call beginExecutionLifecycle because abortExecutionAndWait awaits active.lifecycleDone
    const token = beginExecutionLifecycle("dns-cancel-test", { runId: "test-cancel-run" } as any);

    const events: BridgeEvent[] = [];
    const p = runCli(process.execPath, ["-e", cancelScript, "--", "--sandbox"], cliTestCwd, {
      chatId: "dns-cancel-test",
      bot: "antigravity",
      eventContext: { runId: "test-cancel-run", bot: "antigravity", chatId: "dns-cancel-test" },
      onEvent: (e) => events.push(e),
    });

    // Wait deterministically for first attempt to execute and enter first backoff delay
    await waitForFile(cancelCountFile);
    while (isChildRunning("dns-cancel-test")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const abortPromise = abortExecutionAndWait("dns-cancel-test");

    await expect(p).rejects.toThrow(/CLI execution aborted by user/i);
    completeExecutionLifecycle("dns-cancel-test", token);
    await abortPromise;

    // Wait to ensure no subsequent retries are executed
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(parseInt(readFileSync(cancelCountFile, "utf8"), 10)).toBe(1);

    // Verify exactly one started and one cancelled event (no failures!)
    const startEvents = events.filter((e) => e.type === "run.started");
    const cancelEvents = events.filter((e) => e.type === "run.cancelled");
    const failEvents = events.filter((e) => e.type === "run.failed");
    expect(startEvents.length).toBe(1);
    expect(cancelEvents.length).toBe(1);
    expect(failEvents.length).toBe(0);
  }, 10_000);

  it("does not retry for non-antigravity providers (e.g. claude)", async () => {
    const countFile = join(cliTestCwd, ".dns-non-agy-count");
    if (existsSync(countFile)) rmSync(countFile);

    const script = `
      const fs = require('node:fs');
      let count = 0;
      if (fs.existsSync('${countFile}')) {
        count = parseInt(fs.readFileSync('${countFile}', 'utf8'), 10);
      }
      fs.writeFileSync('${countFile}', String(count + 1));
      console.error('Error: Eligibility check failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: i/o timeout');
      process.exit(1);
    `;

    const p = runCli(process.execPath, ["-e", script, "--", "--sandbox"], cliTestCwd, {
      chatId: "dns-claude-test",
      bot: "claude",
    });

    await expect(p).rejects.toThrow(/CLI exited with code 1/);
    expect(parseInt(readFileSync(countFile, "utf8"), 10)).toBe(1);
  }, 10_000);

  it("does not retry if execution side-effect occurred (non-empty stdout)", async () => {
    const countFile = join(cliTestCwd, ".dns-side-effect-count");
    if (existsSync(countFile)) rmSync(countFile);

    const script = `
      const fs = require('node:fs');
      let count = 0;
      if (fs.existsSync('${countFile}')) {
        count = parseInt(fs.readFileSync('${countFile}', 'utf8'), 10);
      }
      fs.writeFileSync('${countFile}', String(count + 1));
      console.log('some side effect started...');
      console.error('Error: Eligibility check failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: i/o timeout');
      process.exit(1);
    `;

    const p = runCli(process.execPath, ["-e", script, "--", "--sandbox"], cliTestCwd, {
      chatId: "dns-side-effect-test",
      bot: "antigravity",
    });

    await expect(p).rejects.toThrow(/CLI exited with code 1/);
    expect(parseInt(readFileSync(countFile, "utf8"), 10)).toBe(1);
  }, 10_000);

  it("does not retry if the Agy run is not sandboxed/read-only (missing --sandbox)", async () => {
    const countFile = join(cliTestCwd, ".dns-writable-count");
    if (existsSync(countFile)) rmSync(countFile);

    const script = `
      const fs = require('node:fs');
      let count = 0;
      if (fs.existsSync('${countFile}')) {
        count = parseInt(fs.readFileSync('${countFile}', 'utf8'), 10);
      }
      fs.writeFileSync('${countFile}', String(count + 1));
      console.error('Error: Eligibility check failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: i/o timeout');
      process.exit(1);
    `;

    const p = runCli(process.execPath, ["-e", script], cliTestCwd, {
      chatId: "dns-writable-test",
      bot: "antigravity",
    });

    await expect(p).rejects.toThrow(/CLI exited with code 1/);
    expect(parseInt(readFileSync(countFile, "utf8"), 10)).toBe(1);
  }, 10_000);

  it("does not let observer event callback throwing break CLI execution", async () => {
    const script = `
      console.log('{"response": "success output"}');
      process.exit(0);
    `;

    const res = await runCli(process.execPath, ["-e", script], cliTestCwd, {
      chatId: "event-callback-fail-test",
      bot: "antigravity",
      eventContext: { runId: "test-cb-fail", bot: "antigravity", chatId: "event-callback-fail-test" },
      onEvent: () => {
        throw new Error("Observer callback failed fatally!");
      },
    });

    expect(res).toContain("success output");
  }, 10_000);

  it("integrates with production buildCliInvocation and retries when toolMode is none", async () => {
    const countFile = join(cliTestCwd, ".dns-prod-integration-count");
    if (existsSync(countFile)) rmSync(countFile);

    const script = `
      const fs = require('node:fs');
      let count = 0;
      if (fs.existsSync('${countFile}')) {
        count = parseInt(fs.readFileSync('${countFile}', 'utf8'), 10);
      }
      fs.writeFileSync('${countFile}', String(count + 1));
      console.error('Error: Eligibility check failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: i/o timeout');
      process.exit(1);
    `;

    const invocation = buildCliInvocation({
      bot: "antigravity",
      command: process.execPath,
      model: "gemini-3.5-flash-high",
      prompt: "test prompt",
      sessionId: null,
      toolMode: "none",
      executionMode: "safe",
    });

    const args = ["-e", script, "--", ...invocation.args];

    const p = runCli(invocation.command, args, cliTestCwd, {
      chatId: "dns-prod-integration-test",
      ...buildExecutionOptions("antigravity"),
      bypassWorkspaceLock: true,
    });

    await expect(p).rejects.toThrow(/CLI exited with code 1/);
    expect(parseInt(readFileSync(countFile, "utf8"), 10)).toBe(3);
  }, 10_000);

  it("Agy hard timeout emits exactly one outer run.failed with category timeout", async () => {
    const script = `
      setTimeout(() => {}, 10000);
    `;

    const events: BridgeEvent[] = [];
    const p = runCli(process.execPath, ["-e", script, "--", "--sandbox"], cliTestCwd, {
      chatId: "dns-timeout-category-test",
      bot: "antigravity",
      timeoutMs: 200,
      eventContext: { runId: "test-timeout-run", bot: "antigravity", chatId: "dns-timeout-category-test" },
      onEvent: (e) => events.push(e),
    });

    await expect(p).rejects.toThrow(/timeout/i);

    const startEvents = events.filter((e) => e.type === "run.started");
    const failEvents = events.filter((e) => e.type === "run.failed");
    expect(startEvents.length).toBe(1);
    expect(failEvents.length).toBe(1);
    expect((failEvents[0] as any).category).toBe("timeout");
  }, 10_000);

  it("Agy stdout -> text.delta still reaches the collector", async () => {
    const script = `
      console.log("hello stdout delta");
      process.exit(0);
    `;

    const events: BridgeEvent[] = [];
    await runCli(process.execPath, ["-e", script, "--", "--sandbox"], cliTestCwd, {
      chatId: "dns-stdout-delta-test",
      bot: "antigravity",
      eventContext: { runId: "test-delta-run", bot: "antigravity", chatId: "dns-stdout-delta-test" },
      onEvent: (e) => events.push(e),
    });

    const deltaEvents = events.filter((e) => e.type === "text.delta");
    expect(deltaEvents.length).toBeGreaterThan(0);
    expect((deltaEvents[0] as any).text).toContain("hello stdout delta");
  }, 10_000);
});
