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

const conversationId = "11111111-2222-3333-4444-555555555555";

function stream(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("Agy stream-json invocation and parsing contract", () => {
  it("passes --output-format stream-json before --print", () => {
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

  it("does not restore retired json or text output modes from legacy configuration", () => {
    process.env.ANTIGRAVITY_OUTPUT_MODE = "json";
    const jsonRequested = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy",
      model: null,
      outputFormat: "json",
    });
    process.env.ANTIGRAVITY_OUTPUT_MODE = "text";
    const textRequested = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy",
      model: null,
      outputFormat: null,
    });

    for (const invocation of [jsonRequested, textRequested]) {
      const formatIndex = invocation.args.indexOf("--output-format");
      expect(invocation.args[formatIndex + 1]).toBe("stream-json");
    }
  });

  it("keeps stream-json mode when the CLI runner consumes the built invocation", async () => {
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

  it("parses stream-json regardless of a stale generic output-format hint", () => {
    const stdout = stream(
      { conversation_id: conversationId, event: "init", init: { cwd: "/tmp" } },
      { event: "result", result: { status: "SUCCESS", response: "Clean reordered keys response", conversation_id: conversationId } }
    );

    for (const outputFormat of ["stream-json", "json", "text"] as const) {
      expect(parseCliResult({ bot: "antigravity", stdout, outputFormat })).toEqual({
        text: "Clean reordered keys response",
        sessionId: conversationId,
      });
    }
  });
});

describe("Agy stream-json serialized execution boundary", () => {
  it("suppresses NDJSON progress and emits only the parsed terminal completion", async () => {
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
        { homeDir, model: null, applyModel: false },
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
