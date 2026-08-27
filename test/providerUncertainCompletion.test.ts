import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult, runCli } from "../src/cli.js";
import { validateSuccessfulCliExit } from "../src/cliSuccessfulExitValidation.js";
import type { BridgeEvent } from "../src/events/types.js";

const AGY_SESSION = "11111111-2222-3333-4444-555555555555";
const CODEX_SESSION = "codex-session-575";
const GROK_SESSION = "grok-session-575";
const CURSOR_SESSION = "cursor-session-575";

function terminalEvents(events: BridgeEvent[]): BridgeEvent[] {
  return events.filter((event) =>
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

async function providerFixture(
  root: string,
  provider: "codex" | "antigravity" | "grok" | "cursor",
  sessionId: string,
): Promise<string> {
  const script = join(root, `${provider}-fixture`);
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const provider = ${JSON.stringify(provider)};
const sessionId = ${JSON.stringify(sessionId)};
const args = process.argv.slice(2);
const root = process.cwd();
const resumed = provider === "codex" ? args.includes("resume") : args.includes(provider === "antigravity" ? "--conversation" : "--resume");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (!resumed) {
  fs.appendFileSync(path.join(root, "side-effects.txt"), "effect\\n");
  if (provider === "codex") {
    emit({ type: "thread.started", thread_id: sessionId });
    emit({ type: "item.completed", item: { type: "command_execution", text: "SECRET_TOOL_OUTPUT" } });
  } else if (provider === "antigravity") {
    emit({ event: "init", conversation_id: sessionId, init: { cwd: "/private/provider/path" } });
    emit({ event: "step_update", step_update: { step_type: "tool", tool_info: { output: "SECRET_TOOL_OUTPUT" } } });
  } else if (provider === "grok") {
    emit({ type: "tool", data: "SECRET_TOOL_OUTPUT /private/provider/path" });
    emit({ type: "end", sessionId, stopReason: "end_turn" });
  } else {
    emit({ type: "assistant", session_id: sessionId, message: "SECRET_INTERNAL_MESSAGE" });
  }
  process.exit(0);
}
fs.writeFileSync(path.join(root, "recovery-args.json"), JSON.stringify(args));
if (provider === "codex") {
  emit({ type: "thread.started", thread_id: sessionId });
  emit({ type: "item.completed", item: { type: "agent_message", text: "verified final answer" } });
} else if (provider === "antigravity") {
  emit({ event: "result", result: { conversation_id: sessionId, status: "SUCCESS", response: "verified final answer" } });
} else if (provider === "grok") {
  emit({ type: "text", data: "verified final answer" });
  emit({ type: "end", sessionId, stopReason: "end_turn" });
} else {
  emit({ type: "result", subtype: "success", is_error: false, result: "verified final answer", session_id: sessionId });
}
`;
  await writeFile(script, source, { mode: 0o700 });
  return script;
}

describe("provider uncertain completion contract", () => {
  it("fails closed when Codex exit-zero output is malformed", () => {
    expect(() => parseCliResult({
      bot: "codex",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: CODEX_SESSION })}\nnot-json\n`,
    })).toThrow(/completion could not be verified/i);
  });

  it("fails closed when Codex has session evidence but no final answer", () => {
    expect(() => parseCliResult({
      bot: "codex",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: CODEX_SESSION })}\n`,
    })).toThrow(/completion could not be verified/i);
  });

  it("preserves Codex item.updated agent-message finals", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: CODEX_SESSION }),
      JSON.stringify({ type: "item.updated", item: { type: "agent_message", text: "updated final answer" } }),
    ].join("\n") + "\n";

    expect(parseCliResult({ bot: "codex", stdout })).toEqual({
      text: "updated final answer",
      sessionId: CODEX_SESSION,
    });
  });

  it("rejects exit-zero Agy output without a terminal result before run.completed", () => {
    const error = validateSuccessfulCliExit("antigravity", {
      stdout: `${JSON.stringify({ event: "init", conversation_id: AGY_SESSION })}\n`,
      stderr: "",
    });
    expect(error?.message).toMatch(/completion could not be verified/i);
  });

  it("does not trust an invalid Agy conversation id for recovery", () => {
    const error = validateSuccessfulCliExit("antigravity", {
      stdout: `${JSON.stringify({ event: "init", conversation_id: "not-a-uuid" })}\n`,
      stderr: "",
    }) as Error & { sessionId?: string | null };

    expect(error.message).toMatch(/completion could not be verified/i);
    expect(error.sessionId).toBeNull();
  });

  it("does not trust session evidence after a malformed structured boundary", () => {
    const error = validateSuccessfulCliExit("antigravity", {
      stdout: `not-json\n${JSON.stringify({ event: "init", conversation_id: AGY_SESSION })}\n`,
      stderr: "",
    }) as Error & { sessionId?: string | null };

    expect(error.message).toMatch(/completion could not be verified/i);
    expect(error.sessionId).toBeNull();
  });

  it("rejects exit-zero Grok output without terminal evidence before run.completed", () => {
    const error = validateSuccessfulCliExit("grok", {
      stdout: `${JSON.stringify({ type: "text", data: "partial answer" })}\n`,
      stderr: "",
    });
    expect(error?.message).toMatch(/completion could not be verified/i);
  });

  it("rejects exit-zero Cursor output without a terminal result before run.completed", () => {
    const error = validateSuccessfulCliExit("cursor", {
      stdout: `${JSON.stringify({ type: "assistant", session_id: CURSOR_SESSION, message: "internal" })}\n`,
      stderr: "",
    });
    expect(error?.message).toMatch(/completion could not be verified/i);
  });

  it("preserves an explicit Grok failure instead of reconciling it", () => {
    const error = validateSuccessfulCliExit("grok", {
      stdout: [
        JSON.stringify({ type: "error", message: "provider rejected the turn" }),
        JSON.stringify({ type: "end", sessionId: GROK_SESSION, stopReason: "end_turn" }),
      ].join("\n") + "\n",
      stderr: "",
    });
    expect(error?.message).toBe("provider rejected the turn");
  });

  it.each([
    { provider: "codex" as const, bot: "codex" as const, sessionId: CODEX_SESSION, outputFormat: "json" as const },
    { provider: "antigravity" as const, bot: "antigravity" as const, sessionId: AGY_SESSION, outputFormat: "stream-json" as const },
    { provider: "grok" as const, bot: "grok" as const, sessionId: GROK_SESSION, outputFormat: "streaming-json" as const },
    { provider: "cursor" as const, bot: "cursor" as const, sessionId: CURSOR_SESSION, outputFormat: "stream-json" as const },
  ])("reconciles $provider exactly once in the same native session without replaying side effects", async ({ provider, bot, sessionId, outputFormat }) => {
    const root = await mkdtemp(join(tmpdir(), `provider-uncertain-${provider}-`));
    const homeDir = join(root, "home");
    const events: BridgeEvent[] = [];
    try {
      const command = await providerFixture(root, provider, sessionId);
      const invocation = buildCliInvocation({
        bot,
        prompt: "perform one side effect",
        sessionId: null,
        command,
        model: null,
        outputFormat,
        homeDir,
        nativeCompletion: provider === "antigravity",
      });
      const stdout = await runCli(command, invocation.args, root, {
        bot,
        bypassWorkspaceLock: true,
        eventContext: { runId: `uncertain-${provider}`, bot, chatId: "chat:575" },
        onEvent: (event) => events.push(event),
      });

      expect(parseCliResult({ bot, stdout, outputFormat }).text).toBe("verified final answer");
      expect(await readFile(join(root, "side-effects.txt"), "utf8")).toBe("effect\n");
      const recoveryArgs = JSON.parse(await readFile(join(root, "recovery-args.json"), "utf8")) as string[];
      expect(recoveryArgs).toContain(sessionId);
      expect(recoveryArgs.join(" ")).toMatch(/Do not repeat side effects/i);
      expect(stdout).not.toContain("SECRET_TOOL_OUTPUT");
      expect(stdout).not.toContain("SECRET_INTERNAL_MESSAGE");
      expect(stdout).not.toContain("/private/provider/path");
      expect(terminalEvents(events).map((event) => event.type)).toEqual(["run.completed"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a concrete clean incomplete closure when Grok has no recoverable session", async () => {
    const events: BridgeEvent[] = [];
    const raw = `${JSON.stringify({ type: "text", data: "SECRET_PARTIAL_OUTPUT /private/provider/path" })}\n`;
    const script = `process.stdout.write(${JSON.stringify(raw)});`;
    let caught: Error | null = null;
    try {
      await runCli(process.execPath, ["-e", script], process.cwd(), {
        bot: "grok",
        bypassWorkspaceLock: true,
        eventContext: { runId: "uncertain-grok-no-session", bot: "grok", chatId: "chat:575" },
        onEvent: (event) => events.push(event),
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toMatch(/Grok stopped before confirming completion/i);
    expect(caught?.message).not.toContain("SECRET_PARTIAL_OUTPUT");
    expect(caught?.message).not.toContain("/private/provider/path");
    expect(terminalEvents(events)).toMatchObject([{
      type: "run.failed",
      error: expect.stringMatching(/completion could not be verified/i),
    }]);
  });
});
