/**
 * PURPOSE: The one new lower-level primitive issue #351 needs — execute a
 * single bounded agent instruction through the existing chat-independent
 * CLI invocation machinery (buildCliInvocation + runCli, src/cli.ts),
 * correlated to an ordinary bridge_runs row (src/repositories/runRepository.ts),
 * for execution that has no live Telegram chat/session to attach to.
 *
 * Why this exists instead of reusing BridgeEngine directly: BridgeEngine's
 * _executeProviderAttempt/_executeAndDeliverTurnAttempt (src/engine.ts,
 * ~2950 lines) bundle CLI invocation together with Telegram delivery,
 * typing indicators, multi-turn session/continuation merging, and
 * augmented-task/lane-coordinator bookkeeping that only makes sense for a
 * live, possibly-multi-turn chat. None of that applies to a single bounded,
 * non-conversational, report-only turn. buildCliInvocation/runCli
 * underneath is already the plain, chat-independent primitive (the same one
 * Worker job handlers invoke headlessly, e.g. tddImplementation.ts's
 * injected `runCli` dependency) — this module only adds Run
 * creation/correlation/lane-fencing/terminal-state recording around it,
 * reusing the exact bridge_runs + execution_locks mechanics BridgeEngine
 * itself relies on instead of inventing a second Run or lock model.
 *
 * Fencing: the execution_locks lane (db.acquireLock/ownsLock/unlock) is
 * acquired for the duration of the CLI call so two concurrent turns can
 * never run on the same synthetic chat key at once. Cancellation-race
 * safety comes from a different, already-existing guard: bridge_runs'
 * terminal writers (updateRunCompleted/updateRunFailed) are
 * compare-and-swapped on status = 'running' (see runRepository.ts), so a
 * late CLI result racing a concurrent cancellation simply fails to apply —
 * no lock inspection is required for that case.
 *
 * NEIGHBORS: src/cli.ts, src/db.ts, src/repositories/runRepository.ts,
 * src/health/eventIngress.ts
 */
import { randomUUID } from "node:crypto";
import type { BridgeDb } from "./db.js";
import type { BotKind, CliOptions } from "./types.js";
import { buildCliInvocation, buildExecutionOptions, parseCliResult, runCli as defaultRunCli } from "./cli.js";
import { getCliWorkingDir } from "./bridge.js";

export class EventRunLaneUnavailableError extends Error {
  constructor(surface: string, chatKey: string) {
    super(`execution lane ${surface}:${chatKey} is already held by another run`);
    this.name = "EventRunLaneUnavailableError";
  }
}

export interface EventOwnedTurnInput {
  /** Lock namespace, e.g. "health". Never a real Telegram surface. */
  surface: string;
  /** Stable synthetic chat identity for this event kind, e.g. "health:ops". */
  chatKey: string;
  bot: BotKind;
  command: string;
  model: string | null;
  /** The bounded instruction. Runtime code must not encode investigation
   * steps here — AGENTS.md and the agent's own Skills own that reasoning. */
  prompt: string;
}

export interface EventOwnedTurnDeps {
  runCli?: (command: string, args: string[], cwd: string, options?: CliOptions) => Promise<string>;
  runId?: () => string;
}

export interface EventOwnedTurnResult {
  runId: string;
  status: "done" | "failed";
}

/**
 * Creates the owning bridge_runs row, executes exactly one bounded CLI turn
 * fenced by the same execution_locks lane BridgeEngine uses, and records
 * the terminal Run state. Never touches work_items/work_jobs. Throws
 * EventRunLaneUnavailableError (and creates no Run) if another turn already
 * owns the lane — callers decide whether/when to retry.
 */
export async function runEventOwnedTurn(
  db: BridgeDb,
  input: EventOwnedTurnInput,
  deps: EventOwnedTurnDeps = {},
): Promise<EventOwnedTurnResult> {
  const exec = deps.runCli ?? defaultRunCli;
  const makeRunId = deps.runId ?? randomUUID;

  const laneHandle = db.acquireLock(input.surface, input.chatKey);
  if (!laneHandle) throw new EventRunLaneUnavailableError(input.surface, input.chatKey);

  const runId = makeRunId();
  db.insertRun(runId, input.chatKey, input.bot);

  try {
    const invocation = buildCliInvocation({
      bot: input.bot,
      command: input.command,
      model: input.model,
      prompt: input.prompt,
      sessionId: null,
      outputFormat: "json",
    });
    const cwd = getCliWorkingDir(input.bot);
    const stdout = await exec(invocation.command, invocation.args, cwd, {
      ...buildExecutionOptions(input.bot),
      stdin: invocation.stdin,
    });
    const result = parseCliResult({ bot: input.bot, stdout });
    const applied = db.updateRunCompleted(runId, result.text, result.sessionId);
    return { runId, status: applied ? "done" : "failed" };
  } catch (err) {
    db.updateRunFailed(runId, (err as Error).message);
    return { runId, status: "failed" };
  } finally {
    db.unlock(laneHandle);
  }
}
