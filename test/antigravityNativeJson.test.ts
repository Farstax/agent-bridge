import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortCliProcessAndWait,
  buildCliInvocation,
  normalizeCliArgs,
  parseCliResult,
  isCapacityExhaustedError,
} from "../src/cli.js";
import type { BridgeEvent } from "../src/events/types.js";
import { runAntigravitySerialized } from "../src/providers/antigravitySerializedRunner.js";

const originalOutputMode = process.env.ANTIGRAVITY_OUTPUT_MODE;

afterEach(() => {
  if (originalOutputMode === undefined) delete process.env.ANTIGRAVITY_OUTPUT_MODE;
  else process.env.ANTIGRAVITY_OUTPUT_MODE = originalOutputMode;
});

function useOutputMode(mode: string): void {
  process.env.ANTIGRAVITY_OUTPUT_MODE = mode;
}

describe("Agy native JSON invocation contract", () => {
  it("defaults to legacy text mode", () => {
    delete process.env.ANTIGRAVITY_OUTPUT_MODE;

    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy",
      model: null,
    });

    expect(invocation.args).not.toContain("--output-format");
    expect(invocation.args.at(-1)).toContain('schema: {"response"');
  });

  it("adds native JSON before --print and removes the inner JSON prompt contract", () => {
    useOutputMode("json");

    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: "11111111-2222-3333-4444-555555555555",
      command: "agy",
      model: null,
    });

    const outputFormatIndex = invocation.args.indexOf("--output-format");
    const printIndex = invocation.args.indexOf("--print");
    expect(outputFormatIndex).toBeGreaterThan(-1);
    expect(invocation.args[outputFormatIndex + 1]).toBe("json");
    expect(outputFormatIndex).toBeLessThan(printIndex);
    expect(invocation.args.at(-1)).not.toContain('schema: {"response"');
    expect(normalizeCliArgs(invocation.command, invocation.args)).toEqual(invocation.args);
  });

  it("fails clearly for an invalid configured mode", () => {
    useOutputMode("stream-json");

    expect(() => buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy",
      model: null,
    })).toThrow("ANTIGRAVITY_OUTPUT_MODE must be text or json");
  });
});

describe("Agy native JSON parsing contract", () => {
  it("uses the response and invocation-attributable conversation id while tolerating extensions", () => {
    useOutputMode("json");
    const stdout = JSON.stringify({
      conversation_id: "11111111-2222-3333-4444-555555555555",
      status: "SUCCESS",
      response: "Native response\n",
      usage: { total_tokens: 42 },
      structured_output: { ignored: true },
      future_field: "compatible",
    });

    expect(parseCliResult({ bot: "antigravity", stdout })).toEqual({
      text: "Native response",
      sessionId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("uses a replacement conversation id instead of the requested stale id", () => {
    useOutputMode("json");
    const staleId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const replacementId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "resume",
      sessionId: staleId,
      command: "agy",
      model: null,
    });

    expect(invocation.args).toContain(staleId);
    expect(parseCliResult({
      bot: "antigravity",
      stdout: JSON.stringify({
        conversation_id: replacementId,
        status: "SUCCESS",
        response: "replacement accepted",
      }),
    }).sessionId).toBe(replacementId);
  });

  it.each([
    ["malformed JSON", "not json"],
    ["missing conversation", JSON.stringify({ status: "SUCCESS", response: "ok" })],
    ["invalid conversation", JSON.stringify({ conversation_id: "not-a-uuid", status: "SUCCESS", response: "ok" })],
    ["empty response", JSON.stringify({ conversation_id: "11111111-2222-3333-4444-555555555555", status: "SUCCESS", response: "   " })],
    ["unknown status", JSON.stringify({ conversation_id: "11111111-2222-3333-4444-555555555555", status: "DONE", response: "ok" })],
    ["SUCCESS with an error", JSON.stringify({ conversation_id: "11111111-2222-3333-4444-555555555555", status: "SUCCESS", response: "ok", error: "contradiction" })],
    ["ERROR with a response", JSON.stringify({ conversation_id: "11111111-2222-3333-4444-555555555555", status: "ERROR", response: "contradiction", error: "failed" })],
  ])("fails closed for %s", (_label, stdout) => {
    useOutputMode("json");
    expect(() => parseCliResult({ bot: "antigravity", stdout })).toThrow(/Agy native JSON/);
  });

  it("throws the provider error from an ERROR envelope", () => {
    useOutputMode("json");
    const stdout = JSON.stringify({
      conversation_id: "11111111-2222-3333-4444-555555555555",
      status: "ERROR",
      response: "",
      error: "No capacity available for selected model",
    });

    let error: Error | null = null;
    try {
      parseCliResult({ bot: "antigravity", stdout });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toBe("No capacity available for selected model");
    expect(isCapacityExhaustedError(error!)).toBe(true);
  });

  it("classifies a native timeout through the existing timeout contract", () => {
    useOutputMode("json");
    const stdout = JSON.stringify({
      conversation_id: "11111111-2222-3333-4444-555555555555",
      status: "ERROR",
      response: "",
      error: "timeout waiting for response",
    });

    let error: (Error & { category?: string }) | null = null;
    try {
      parseCliResult({ bot: "antigravity", stdout });
    } catch (caught) {
      error = caught as Error & { category?: string };
    }
    expect(error?.message).toBe("Agy execution timed out waiting for response");
    expect(error?.category).toBe("timeout");
  });

  it("preserves the legacy text parser as the rollback path", () => {
    useOutputMode("text");
    const conversationId = "cccccccc-dddd-eeee-ffff-000000000000";
    expect(parseCliResult({
      bot: "antigravity",
      stdout: JSON.stringify({ response: "legacy response" }),
      logContent: `Created conversation ${conversationId}`,
    })).toEqual({ text: "legacy response", sessionId: conversationId });
  });
});

describe("Agy native JSON serialized execution boundary", () => {
  it("buffers chunked JSON, suppresses raw progress, and emits the parsed completion", async () => {
    useOutputMode("json");
    const root = await mkdtemp(join(tmpdir(), "agy-native-json-success-"));
    const homeDir = join(root, "home");
    const script = join(root, "agy-fixture");
    const conversationId = "22222222-3333-4444-5555-666666666666";
    await mkdir(homeDir, { recursive: true });
    await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
printf '{"conversation_id":"${conversationId}","status":"SUCCESS",'
sleep 0.05
printf '"response":"chunked native response","usage":{"total_tokens":7}}\\n'
`, { mode: 0o700 });
    const progress: string[] = [];
    const events: BridgeEvent[] = [];

    try {
      const { stdout } = await runAntigravitySerialized(
        script,
        ["--output-format", "json", "--print", "hello"],
        root,
        {
          bot: "antigravity",
          chatId: "telegram:interactive:topic",
          timeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          eventContext: { runId: "native-json-success", bot: "antigravity", chatId: "chat:topic" },
          onEvent: (event) => events.push(event),
        },
        { homeDir, model: null, applyModel: false, outputMode: "json" } as never,
        (chunk) => progress.push(chunk),
      );

      expect(progress).toEqual([]);
      expect(events.filter((event) => event.type === "text.delta")).toEqual([]);
      expect(events.filter((event) => event.type === "run.completed")).toMatchObject([{
        type: "run.completed",
        text: "chunked native response",
        sessionId: conversationId,
      }]);
      expect(parseCliResult({ bot: "antigravity", stdout })).toEqual({
        text: "chunked native response",
        sessionId: conversationId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interprets a nonzero native error inside the provider boundary", async () => {
    useOutputMode("json");
    const root = await mkdtemp(join(tmpdir(), "agy-native-json-error-"));
    const homeDir = join(root, "home");
    const script = join(root, "agy-fixture");
    const events: BridgeEvent[] = [];
    await mkdir(homeDir, { recursive: true });
    await writeFile(script, `#!/usr/bin/env bash
printf '%s\\n' '{"conversation_id":"33333333-4444-5555-6666-777777777777","status":"ERROR","response":"","error":"No capacity available for selected model"}'
exit 1
`, { mode: 0o700 });

    try {
      let caught: Error | null = null;
      try {
        await runAntigravitySerialized(
          script,
          ["--output-format", "json", "--print", "hello"],
          root,
          {
            bot: "antigravity",
            chatId: "telegram:interactive:error",
            timeoutMs: 5_000,
            idleTimeoutMs: 5_000,
            eventContext: { runId: "native-json-error", bot: "antigravity", chatId: "chat:error" },
            onEvent: (event) => events.push(event),
          },
          { homeDir, model: null, applyModel: false, outputMode: "json" } as never,
        );
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).toBe("No capacity available for selected model");
      expect(events.filter((event) => event.type === "run.failed")).toMatchObject([{
        type: "run.failed",
        error: "No capacity available for selected model",
      }]);
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cancellation authoritative over partial native JSON", async () => {
    useOutputMode("json");
    const root = await mkdtemp(join(tmpdir(), "agy-native-json-cancel-"));
    const homeDir = join(root, "home");
    const script = join(root, "agy-fixture");
    const chatId = "telegram:interactive:cancel";
    const progress: string[] = [];
    const events: BridgeEvent[] = [];
    await mkdir(homeDir, { recursive: true });
    await writeFile(script, `#!/usr/bin/env bash
printf '%s' '{"conversation_id":"44444444-5555-6666-7777-888888888888","status":"SUCCESS"'
sleep 10
`, { mode: 0o700 });

    try {
      const execution = runAntigravitySerialized(
        script,
        ["--output-format", "json", "--print", "hello"],
        root,
        {
          bot: "antigravity",
          chatId,
          timeoutMs: 15_000,
          idleTimeoutMs: 15_000,
          killGraceMs: 50,
          eventContext: { runId: "native-json-cancel", bot: "antigravity", chatId: "chat:cancel" },
          onEvent: (event) => events.push(event),
        },
        { homeDir, model: null, applyModel: false, outputMode: "json" } as never,
        (chunk) => progress.push(chunk),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await abortCliProcessAndWait(chatId);

      const cancellationError = await execution;
      expect(cancellationError?.message).toContain("aborted by user");
      expect(progress).toEqual([]);
      expect(events.some((event) => event.type === "run.cancelled")).toBe(true);
      expect(events.some((event) => event.type === "run.failed")).toBe(false);
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
