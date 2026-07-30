/**
 * PURPOSE: Single authoritative child-process lifecycle for CLI execution —
 * spawning, environment scrubbing, the process registry, timers, event
 * emission, cancellation/termination, and close/error settlement.
 * INPUTS: Command/args/cwd plus CliOptions.
 * OUTPUTS: A settled { stdout } outcome; runCli/runCliAsync in src/cli.ts are
 * thin adapters that call runSupervisedProcess() and reshape its return value.
 * NEIGHBORS: src/cli.ts, src/workspaceLock.ts, src/db.ts
 * LOGIC: Issue #135 Phase 2 — replaces what were previously two independently
 * duplicated implementations (runCli, runCliAsync) with one internal runner.
 * Preserves the exact public contracts of runCli()/runCliAsync() and every
 * cancellation/timeout/registry guarantee they previously provided.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CliOptions } from "./types.js";
import { type as evtType } from "./events/types.js";
import type { BridgeEvent } from "./events/types.js";
import type { ExecutionLaneHandle } from "./db.js";
import { buildWorkspaceLockedInvocation } from "./workspaceLock.js";
import { normalizeCliArgs } from "./cliArgNormalization.js";

interface ActiveExecution {
  child: ChildProcess | null;
  abortRequested: boolean;
  lifecycleToken: string | null;
  lifecycleHandle: ExecutionLaneHandle | null;
  lifecycleDone: Promise<void> | null;
  finishLifecycle: (() => void) | null;
}

// The single process registry. Both runCli() and runCliAsync() route through
// runSupervisedProcess() below, which is the only code that reads or writes
// this map — there is no second registry.
const activeExecutions = new Map<number | string, ActiveExecution>();
const abortedChildren = new WeakSet<ChildProcess>();

const STRIPPED_ENV_KEYS = /^TELEGRAM_BOT_TOKEN|^TELEGRAM_ALLOWED_USER_IDS/;
const ADVISOR_SECRET_ENV_KEYS = /^(?:AGENT_)?BRIDGE_.*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export function buildSafeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !STRIPPED_ENV_KEYS.test(k)),
  );
}

export function buildAdvisorChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(buildSafeChildEnv(env)).filter(([key]) =>
      !key.startsWith("AGENT_BRIDGE_ADVISOR_")
      && !key.startsWith("BRIDGE_ADVISOR_")
      && !ADVISOR_SECRET_ENV_KEYS.test(key),
    ),
  );
}

function buildChildEnv(extraEnv?: Record<string, string>, advisorChild = false): NodeJS.ProcessEnv {
  const base = advisorChild ? buildAdvisorChildEnv() : buildSafeChildEnv();
  const merged = {
    ...base,
    ...(extraEnv ?? {}),
  };
  return advisorChild ? buildAdvisorChildEnv(merged) : merged;
}

const KILL_GRACE_MS = 5_000;
const GROUP_EXIT_POLL_INTERVAL_MS = 25;
const GROUP_EXIT_POLL_BOUND_MS = 1_000;
const RUN_MARKER_ENV = "AGENT_BRIDGE_RUN_ID";
const SERVICE_MARKER_ENV = "AGENT_BRIDGE_SERVICE_ID";
const ACQUISITION_MARKER_ENV = "AGENT_BRIDGE_ACQUISITION_ID";

export type ExecutionProcessState = "live" | "absent" | "ambiguous";

export function resolveSupervisorTimeouts(options: Pick<CliOptions, "timeoutMs" | "idleTimeoutMs"> = {}): {
  timeoutMs: number;
  idleTimeoutMs: number | null;
} {
  return {
    timeoutMs: options.timeoutMs ?? 0,
    idleTimeoutMs: options.idleTimeoutMs ?? null,
  };
}

/**
 * Sends SIGTERM to the full process group (child spawned with detached:true
 * is the group leader) and escalates to SIGKILL after graceMs — unless a
 * liveness probe at escalation time shows nothing left in the group. Returns
 * a promise that resolves only once the whole group is confirmed dead (or
 * the bounded poll gives up), not merely once SIGTERM/SIGKILL was sent.
 *
 * Escalation deliberately does NOT cancel on the direct child's "close"
 * event: the group leader can exit (and fire "close") while a TERM-resistant
 * descendant in the same process group is still alive and still needs the
 * SIGKILL. Falls back to signalling the direct child only when no pid is
 * available (e.g. spawn failed before a pid was assigned).
 */
function killChildTree(child: ChildProcess, graceMs: number = KILL_GRACE_MS): Promise<void> {
  const pid = child.pid;
  const signal = (sig: NodeJS.Signals) => {
    if (pid) {
      try { process.kill(-pid, sig); return; } catch { /* group may already be gone; fall through */ }
    }
    try { child.kill(sig); } catch { /* ignore */ }
  };
  signal("SIGTERM");
  if (!pid) return Promise.resolve();

  // Poll continuously from the moment SIGTERM is sent — do NOT wait until
  // graceMs elapses before checking liveness. Most processes die well before
  // the grace deadline; only a still-alive group at the deadline gets
  // escalated to SIGKILL.
  return new Promise((resolve) => {
    const escalateAt = Date.now() + graceMs;
    const giveUpAt = escalateAt + GROUP_EXIT_POLL_BOUND_MS;
    let escalated = false;
    const poll = () => {
      try {
        process.kill(-pid, 0);
      } catch {
        resolve(); // ESRCH: group empty, whether before or after escalation
        return;
      }
      const now = Date.now();
      if (!escalated && now >= escalateAt) {
        escalated = true;
        signal("SIGKILL");
      } else if (escalated && now >= giveUpAt) {
        resolve(); // bounded — give up on an unreapable/zombie entry
        return;
      }
      setTimeout(poll, GROUP_EXIT_POLL_INTERVAL_MS);
    };
    poll();
  });
}

/**
 * Structured cancellation reason for a configured hard/idle timeout (Issue
 * #177) — callers must branch on `timeoutKind`, not on Error#message text.
 */
export class CliTimeoutError extends Error {
  public readonly category = "timeout";
  constructor(message: string, public readonly timeoutKind: "hard" | "idle") {
    super(message);
    this.name = "CliTimeoutError";
  }
}

function killChild(child: ChildProcess, graceMs: number = KILL_GRACE_MS): Promise<void> {
  abortedChildren.add(child);
  return killChildTree(child, graceMs);
}

/**
 * Removes a chat's process registration only if it still points at this child.
 * A retry/fallback spawn may have re-registered the same chatId; a late close
 * from the older child must not deregister the newer process.
 */
function deregisterProcess(chatId: number | string, child: ChildProcess): void {
  const active = activeExecutions.get(chatId);
  if (active?.child === child) {
    active.child = null;
    if (!active.lifecycleToken && !active.abortRequested) activeExecutions.delete(chatId);
  }
}

function registerProcess(chatId: number | string, child: ChildProcess): void {
  const active = activeExecutions.get(chatId);
  if (active) active.child = child;
  else activeExecutions.set(chatId, { child, abortRequested: false, lifecycleToken: null, lifecycleHandle: null, lifecycleDone: null, finishLifecycle: null });
}

export function beginExecutionLifecycle(chatId: number | string, handle: ExecutionLaneHandle): string {
  const token = randomUUID();
  let finishLifecycle!: () => void;
  const lifecycleDone = new Promise<void>((resolve) => { finishLifecycle = resolve; });
  const active = activeExecutions.get(chatId);
  activeExecutions.set(chatId, {
    child: active?.child ?? null,
    abortRequested: active?.abortRequested ?? false,
    lifecycleToken: token,
    lifecycleHandle: handle,
    lifecycleDone,
    finishLifecycle,
  });
  return token;
}

export function completeExecutionLifecycle(chatId: number | string, token: string): void {
  const active = activeExecutions.get(chatId);
  if (!active || active.lifecycleToken !== token) return;
  active.finishLifecycle?.();
  active.lifecycleToken = null;
  active.lifecycleHandle = null;
  active.lifecycleDone = null;
  active.finishLifecycle = null;
  if (!active.child) activeExecutions.delete(chatId);
}

/** Returns whether this process still owns a live execution for a durable run ID. */
export function getExecutionProcessState(runId: string): ExecutionProcessState {
  for (const active of activeExecutions.values()) {
    if (active.lifecycleHandle?.runId === runId) return "live";
  }

  try {
    const processTable = execFileSync("/usr/bin/ps", ["eww", "-eo", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return processTable.includes(RUN_MARKER_ENV + "=" + runId) ? "live" : "absent";
  } catch {
    return "ambiguous";
  }
}

export function isExecutionActive(runId: string): boolean {
  return getExecutionProcessState(runId) === "live";
}

export function abortCliProcess(chatId: number | string): boolean {
  const active = activeExecutions.get(chatId);
  if (!active) return false;
  active.abortRequested = true;
  let abortedSomething = true;
  if (active?.child) {
    killChild(active.child);
    abortedSomething = true;
  }
  return abortedSomething;
}

export async function abortCliProcessAndWait(chatId: number | string): Promise<boolean> {
  const active = activeExecutions.get(chatId);
  if (!active) return false;
  active.abortRequested = true;
  let abortedSomething = true;
  const closedPromises: Promise<void>[] = [];

  if (active?.child) {
    const child = active.child;
    const closed = new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("close", done);
      child.once("error", done);
    });
    closedPromises.push(closed);
    closedPromises.push(killChild(child));
    abortedSomething = true;
  }

  if (closedPromises.length > 0) {
    await Promise.all(closedPromises);
  }
  return abortedSomething;
}

export function isAbortRequested(chatId: string | number): boolean {
  const active = activeExecutions.get(chatId);
  return active?.abortRequested ?? false;
}

export function isChildRunning(chatId: string | number): boolean {
  const active = activeExecutions.get(chatId);
  return !!active?.child;
}

export async function abortExecutionAndWait(chatId: number | string): Promise<ExecutionLaneHandle | null> {
  const active = activeExecutions.get(chatId);
  if (!active) return null;
  const handle = active.lifecycleHandle;
  if (active.child) {
    await abortCliProcessAndWait(chatId);
  } else {
    active.abortRequested = true;
  }
  await active.lifecycleDone;
  return handle;
}

export function shutdownCliProcesses(): number {
  const children = [...activeExecutions.values()].flatMap((active) => active.child ? [active.child] : []);
  for (const child of children) {
    killChild(child);
  }
  const count = children.length;
  activeExecutions.clear();
  return count;
}

/**
 * Test/process teardown variant that does not return until every tracked
 * child, and every descendant in its process group, is confirmed dead.
 */
export async function shutdownCliProcessesAndWait(): Promise<number> {
  const children = [...new Set(
    [...activeExecutions.values()].flatMap((active) => active.child ? [active.child] : []),
  )];
  const exits = children.map((child) => {
    const closed = new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("close", done);
      child.once("error", done);
    });
    abortedChildren.add(child);
    return Promise.all([closed, killChildTree(child, 100)]);
  });
  await Promise.all(exits);
  for (const [chatId, active] of activeExecutions) {
    if (!active.child && !active.lifecycleToken) activeExecutions.delete(chatId);
  }
  return children.length;
}

const PROMPT_REDACT_THRESHOLD = 100;

/** Replaces any arg longer than PROMPT_REDACT_THRESHOLD with a size-only placeholder. */
export function redactArgs(args: string[]): string[] {
  return args.map((arg) =>
    arg.length > PROMPT_REDACT_THRESHOLD ? `[prompt: ${arg.length}chars]` : arg
  );
}

function formatSpawnLog(command: string, args: string[], cwd: string, chatId?: number | string, stdin?: string): string {
  const safeArgs = redactArgs(args).map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");
  const chatPart = chatId != null ? ` chatId=${String(chatId)}` : "";
  const stdinPart = stdin ? ` stdin=[${stdin.length}chars]` : "";
  return `[spawn]${chatPart} cwd=${cwd} command=${command} args=${safeArgs}${stdinPart}`;
}

/**
 * The single authoritative child-process lifecycle. runCli() and
 * runCliAsync() in src/cli.ts are thin adapters over this function; both
 * share identical spawn/env/timer/registry/cancellation/settlement behaviour.
 */
export async function runSupervisedProcess(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions = {},
  onProgress?: (text: string) => void,
): Promise<{ stdout: string }> {
  const { timeoutMs, idleTimeoutMs } = resolveSupervisorTimeouts(options);
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const onEvent = options.onEvent;
  const evtCtx = options.eventContext;

  const emit = (e: BridgeEvent) => {
    try {
      if (e.type === "run.started") {
        console.log(`[event] run.started runId=${e.runId} bot=${e.bot} chatId=${e.chatId}`);
      } else if (e.type === "run.completed") {
        console.log(`[event] run.completed runId=${e.runId} sessionId=${e.sessionId}`);
      } else if (e.type === "run.failed") {
        console.log(`[event] run.failed runId=${e.runId} category=${e.category} error="${e.error.replace(/\n/g, " ")}"`);
      } else if (e.type === "run.cancelled") {
        console.log(`[event] run.cancelled runId=${e.runId} reason=${e.reason}`);
      }
      onEvent?.(e);
    } catch {
      /* never let event emission break execution */
    }
  };

  return new Promise((resolve, reject) => {
    const normalizedArgs = normalizeCliArgs(command, args);
    const spawnInvocation = buildWorkspaceLockedInvocation(command, normalizedArgs, cwd, {
      bypassWorkspaceLock: options.bypassWorkspaceLock,
    });
    console.log(formatSpawnLog(command, normalizedArgs, cwd, options.chatId, options.stdin));
    // detached:true puts the child in its own process group so timeout kills
    // can signal the whole subtree (process.kill(-pid)) instead of stranding
    // grandchildren.
    const childEnv = buildChildEnv(options.contextEnv, options.advisorChild);
    if (options.eventContext?.runId) childEnv[RUN_MARKER_ENV] = options.eventContext.runId;
    if (options.eventContext?.serviceId) childEnv[SERVICE_MARKER_ENV] = options.eventContext.serviceId;
    if (options.eventContext?.acquisitionId) childEnv[ACQUISITION_MARKER_ENV] = options.eventContext.acquisitionId;
    const child = spawn(spawnInvocation.command, spawnInvocation.args, { cwd, shell: false, detached: true, env: childEnv });
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
    if (options.chatId != null) registerProcess(options.chatId, child);
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let pendingError: Error | null = null;
    let pendingKill: Promise<void> | null = null;

    if (evtCtx) emit(evtType.runStarted({ ...evtCtx, command, cwd, model: null }));

    const doReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const doResolve = (val: { stdout: string }) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    // timeoutMs === 0 means the hard timeout is disabled (Issue #177 canonical default).
    const timer: NodeJS.Timeout | null = timeoutMs === 0 ? null : setTimeout(() => {
      if (settled || pendingError) return;
      console.error(`[HARD TIMEOUT] CLI hard timeout after ${timeoutMs}ms - killing process\n${formatSpawnLog(command, args, cwd, options.chatId)}`);
      if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI hard timeout after ${timeoutMs}ms`, category: "timeout" }));
      pendingError = new CliTimeoutError(`CLI hard timeout after ${timeoutMs}ms`, "hard");
      pendingKill = killChildTree(child, killGraceMs);
    }, timeoutMs);

    const processWatchTimer = options.processWatch?.({
      args: normalizedArgs,
      readStdout: () => stdout,
      onFailure: (error, category = "unknown") => {
        if (settled || pendingError) return;
        console.error(`[PROCESS WATCH] ${error.message}${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""}`);
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: error.message, category }));
        (error as any).category = category;
        pendingError = error;
        pendingKill = killChildTree(child, killGraceMs);
      },
    }) ?? null;

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      // null or 0 means the idle timeout is disabled (Issue #177 canonical default).
      if (idleTimeoutMs === null || idleTimeoutMs === 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || pendingError) return;
        console.error(`[IDLE TIMEOUT] CLI idle timeout after ${idleTimeoutMs}ms with no stdout/stderr${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""}`);
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI idle timeout after ${idleTimeoutMs}ms`, category: "timeout" }));
        pendingError = new CliTimeoutError(`CLI idle timeout after ${idleTimeoutMs}ms`, "idle");
        pendingKill = killChildTree(child, killGraceMs);
      }, idleTimeoutMs);
    };

    resetIdleTimer();

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      resetIdleTimer();
      if (onProgress) onProgress(chunk);
      if (evtCtx) emit(evtType.textDelta({ ...evtCtx, text: chunk, source: "stdout" }));
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[stderr]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} ${chunk.trimEnd()}`);
      resetIdleTimer();
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (processWatchTimer) clearInterval(processWatchTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) deregisterProcess(options.chatId, child);
      console.log(`[close]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} code=${code} signal=${signal ?? "none"}`);

      if (settled) return;
      if (pendingError) {
        const err = pendingError;
        // Don't settle until the full process-group kill is confirmed
        // complete — the group leader closing here doesn't mean a
        // TERM-resistant descendant has died yet.
        (pendingKill ?? Promise.resolve()).then(() => doReject(err));
        return;
      }

      if (signal && abortedChildren.has(child)) {
        if (evtCtx) emit(evtType.runCancelled({ ...evtCtx, reason: "user" }));
        doResolve({ stdout });
      } else if (signal) {
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI killed by signal ${signal}`, category: "cli" }));
        const combined = [stderr.trim(), stdout.slice(-2000).trim()].filter(Boolean).join("\n");
        const err = new Error(`CLI killed by signal ${signal}: ${combined}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        doReject(err);
      } else if (code !== 0 && code !== null) {
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI exited with code ${code}`, category: "cli" }));
        const combined = [stderr.trim(), stdout.slice(-2000).trim()].filter(Boolean).join("\n");
        const err = new Error(`CLI exited with code ${code}: ${combined}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        doReject(err);
      } else {
        if (evtCtx) emit(evtType.runCompleted({ ...evtCtx, text: stdout, sessionId: null }));
        doResolve({ stdout });
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (processWatchTimer) clearInterval(processWatchTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) deregisterProcess(options.chatId, child);
      if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: err.message, category: "cli" }));
      doReject(err);
    });
  });
}
