import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  abortCliProcessAndWait,
  isCapacityExhaustedError,
  parseCliResult,
} from "../src/cli.js";
import type { BridgeEvent } from "../src/events/types.js";
import { runAntigravitySerialized } from "../src/providers/antigravitySerializedRunner.js";

function stream(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("Agy stream-json compatibility invariants", () => {
  it("preserves capacity classification from a terminal ERROR result", () => {
    const stdout = stream({
      event: "result",
      result: {
        conversation_id: "11111111-2222-3333-4444-555555555555",
        status: "ERROR",
        response: "",
        error: "No capacity available for selected model",
      },
    });

    let caught: Error | null = null;
    try {
      parseCliResult({ bot: "antigravity", stdout });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe("No capacity available for selected model");
    expect(isCapacityExhaustedError(caught!)).toBe(true);
  });

  it("uses the terminal replacement conversation id for a resumed run", () => {
    const replacementId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const stdout = stream(
      { event: "init", conversation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      {
        event: "result",
        result: {
          conversation_id: replacementId,
          status: "SUCCESS",
          response: "replacement accepted",
        },
      },
    );

    expect(parseCliResult({ bot: "antigravity", stdout })).toEqual({
      text: "replacement accepted",
      sessionId: replacementId,
    });
  });

  it("keeps cancellation authoritative over a partial stream before terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-stream-json-cancel-"));
    const homeDir = join(root, "home");
    const script = join(root, "agy-fixture");
    const chatId = "telegram:interactive:stream-json-cancel";
    const progress: string[] = [];
    const events: BridgeEvent[] = [];
    await mkdir(homeDir, { recursive: true });
    await writeFile(script, `#!/usr/bin/env bash\nprintf '%s\\n' '{"event":"init","conversation_id":"44444444-5555-6666-7777-888888888888"}'\nprintf '%s\\n' '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool"}}'\nsleep 10\n`, { mode: 0o700 });

    try {
      const execution = runAntigravitySerialized(
        script,
        ["--output-format", "stream-json", "--print", "hello"],
        root,
        {
          bot: "antigravity",
          chatId,
          timeoutMs: 15_000,
          idleTimeoutMs: 15_000,
          killGraceMs: 50,
          eventContext: { runId: "stream-json-cancel", bot: "antigravity", chatId: "chat:stream-json-cancel" },
          onEvent: (event) => events.push(event),
        },
        { homeDir, model: null, applyModel: false },
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
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
