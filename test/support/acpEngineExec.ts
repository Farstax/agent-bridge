import { appendOutputDirInstruction, wrapPromptContext } from "../../src/promptWrapping.js";

/**
 * Every provider is ACP-transport now (codex, claude, grok, agy, cursor) --
 * BridgeEngine's `runCli`/`runCliAsync` exec seam is dead for all of them.
 * Generic engine-mechanics tests (queueing, locking, handoff, coalescing,
 * etc.) don't care which provider they exercise, so this adapter lets them
 * keep their existing "mock a CLI process, return raw stdout" fixtures while
 * routing through the seam BridgeEngine actually calls for ACP-transport
 * providers: `runProviderInvocation`.
 *
 * The real ACP path (acpRuntime.ts's promptBlocks()) wraps the request's
 * prompt with Soul contract / response-style / output-dir instructions at
 * request-build time. The delegation/execution contract is seeded earlier,
 * into request.prompt itself, by src/cli.ts::seedFreshExecutionContract().
 * Mirror that wrapping here so fixtures that assert on the final wire
 * content (Soul contract, output-dir stripping) see the same text a real
 * ACP agent would, without double-adding the execution contract.
 */

export function parseAcpMockStdout(stdout: string): {
  text: string;
  sessionId: string | null;
  stopReason?: string;
} {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let text: string | null = null;
  let sessionId: string | null = null;
  let stopReason: string | undefined;
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.result === "string" && record.result.trim()) {
      text = record.result.trim();
      if (typeof record.session_id === "string") sessionId = record.session_id;
    }
    if (record.type === "text" && typeof record.data === "string") {
      text = record.data;
    }
    if (record.type === "end") {
      if (typeof record.sessionId === "string") sessionId = record.sessionId;
      if (typeof record.stopReason === "string") stopReason = record.stopReason;
    }
  }
  if (text === null) return { text: stdout.trim(), sessionId, stopReason };
  return { text, sessionId, stopReason };
}

/**
 * Adapts a classic runCli-style mock (spawns a fake CLI, returns raw stdout)
 * into a runProviderInvocation-compatible executor. Accepts either a bare
 * mock function or an exec-options object with a `runCli` key; passes
 * through any other exec keys (e.g. an explicit `runProviderInvocation`)
 * untouched.
 */
export function acpEngineExec(runCliOrExec: any = {}) {
  const exec = typeof runCliOrExec === "function" ? { runCli: runCliOrExec } : { ...runCliOrExec };
  const run = exec.runCli;
  if (!run) return exec;
  return {
    ...exec,
    runProviderInvocation: exec.runProviderInvocation ?? (async (
      _bot: string,
      invocation: any,
      cwd: string,
      options: any,
      request: any,
    ) => {
      // Issue #903: the delegation/execution contract is now seeded upstream
      // in src/cli.ts::seedFreshExecutionContract() (into request.prompt
      // itself) so it reaches both fresh and resumed sessions; promptBlocks()
      // in acpRuntime.ts no longer adds it again here, so this mirror must not either.
      const wrappedPrompt = appendOutputDirInstruction(
        wrapPromptContext(request.prompt, request.soulContext, request.includeResponseContract, false),
        request.outputDir,
      );
      const args = ["-p", wrappedPrompt, "--output-format", "json"];
      if (request.sessionId) args.push("--resume", request.sessionId);
      if (request.model) args.push("--model", request.model);
      const raw = await run(invocation.command, args, cwd, options);
      const stdout = typeof raw === "string" ? raw : raw?.text ?? "";
      return parseAcpMockStdout(stdout);
    }),
  };
}
