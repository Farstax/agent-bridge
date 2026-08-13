import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult, runCli } from "../src/cli.js";
import type { BridgeEvent } from "../src/events/types.js";
import { runAntigravitySerialized } from "../src/providers/antigravitySerializedRunner.js";

const originalOutputMode = process.env.ANTIGRAVITY_OUTPUT_MODE;

afterEach(() => {
  if (originalOutputMode === undefined) delete process.env.ANTIGRAVITY_OUTPUT_MODE;
  else process.env.ANTIGRAVITY_OUTPUT_MODE = originalOutputMode;
});

function useStreamJson(): void {
  process.env.ANTIGRAVITY_OUTPUT_MODE = "stream-json";
}

const conversationId = "11111111-2222-3333-4444-555555555555";

function stream(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("Agy stream-json invocation and parsing contract", () => {
  it("passes --output-format stream-json before --print", () => {
    useStreamJson();
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy",
      model: null,
    });

    const formatIndex = invocation.args.indexOf("--output-format");
    const printIndex = invocation.args.indexOf("--print");
    expect(formatIndex).toBeGreaterThan(-1);
    expect(invocation.args[formatIndex + 1]).toBe("stream-json");
    expect(formatIndex).toBeLessThan(printIndex);
  });

  it("keeps stream-json mode when the CLI runner consumes the built invocation", async () => {
    useStreamJson();
    const root = await mkdtemp(join(tmpdir(), "agy-cli-stream-json-"));
    const script = join(root, "agy-fixture");
    await writeFile(script, `#!/usr/bin/env bash
printf '%s\\n' '${JSON.stringify({ event: "init", conversation_id: conversationId })}'
printf '%s\\n' '${JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "stream response" } })}'
`, { mode: 0o700 });
    try {
      const invocation = buildCliInvocation({
        bot: "antigravity",
        prompt: "hello",
        sessionId: null,
        command: script,
        model: null,
      });
      await expect(runCli(script, invocation.args, root, { bot: "antigravity" })).resolves.toContain("stream response");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns only the terminal result response and ignores tool/system telemetry", () => {
    useStreamJson();
    const stdout = stream(
      { event: "init", conversation_id: conversationId, init: { cwd: "/tmp" } },
      { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_info: { output: "SECRET TOOL STDOUT" } } },
      { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "system_message", text: "Task abc has finished === stderr === noisy" } },
      { event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "Clean final answer", usage: { total_tokens: 42 } } },
    );

    expect(parseCliResult({ bot: "antigravity", stdout })).toEqual({
      text: "Clean final answer",
      sessionId: conversationId,
    });
  });

  it("fails closed for malformed, missing, duplicate, and invalid terminal results", () => {
    useStreamJson();
    const cases = [
      "not-json\n",
      stream({ event: "init", conversation_id: conversationId }),
      stream(
        { event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "first" } },
        { event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "second" } },
      ),
      stream({ event: "result", result: { conversation_id: "not-a-uuid", status: "SUCCESS", response: "ok" } }),
      stream({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "   " } }),
    ];

    for (const stdout of cases) {
      expect(() => parseCliResult({ bot: "antigravity", stdout })).toThrow(/Agy stream JSON/i);
    }
  });

  it("classifies a terminal timeout error through the existing timeout contract", () => {
    useStreamJson();
    const stdout = stream({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "ERROR",
        response: "",
        error: "timeout waiting for response",
      },
    });

    let caught: (Error & { category?: string }) | null = null;
    try {
      parseCliResult({ bot: "antigravity", stdout });
    } catch (error) {
      caught = error as Error & { category?: string };
    }
    expect(caught?.message).toBe("Agy execution timed out waiting for response");
    expect(caught?.category).toBe("timeout");
  });
});

describe("Agy stream-json serialized execution boundary", () => {
  it("suppresses NDJSON progress and emits only the parsed terminal completion", async () => {
    useStreamJson();
    const root = await mkdtemp(join(tmpdir(), "agy-stream-json-"));
    const homeDir = join(root, "home");
    const script = join(root, "agy-fixture");
    await mkdir(homeDir, { recursive: true });
    await writeFile(script, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' '${JSON.stringify({ event: "init", conversation_id: conversationId })}'\nprintf '%s\\n' '${JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_info: { output: "raw tool output" } } })}'\nprintf '%s\\n' '${JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "authoritative final" } })}'\n`, { mode: 0o700 });
    const progress: string[] = [];
    const events: BridgeEvent[] = [];

    try {
      const { stdout } = await runAntigravitySerialized(
        script,
        ["--output-format", "stream-json", "--print", "hello"],
        root,
        {
          bot: "antigravity",
          chatId: "telegram:interactive:stream-json",
          timeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          eventContext: { runId: "stream-json-success", bot: "antigravity", chatId: "chat:stream-json" },
          onEvent: (event) => events.push(event),
        },
        { homeDir, model: null, applyModel: false, outputMode: "stream-json" } as never,
        (chunk) => progress.push(chunk),
      );

      expect(progress).toEqual([]);
      expect(events.filter((event) => event.type === "text.delta")).toEqual([]);
      expect(events.filter((event) => event.type === "run.completed")).toMatchObject([{
        type: "run.completed",
        text: "authoritative final",
        sessionId: conversationId,
      }]);
      expect(parseCliResult({ bot: "antigravity", stdout })).toEqual({
        text: "authoritative final",
        sessionId: conversationId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
