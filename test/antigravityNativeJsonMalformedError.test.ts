import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../src/events/types.js";
import { runAntigravitySerialized } from "../src/providers/antigravitySerializedRunner.js";

describe("Agy native JSON malformed ERROR envelope handling", () => {
  it("classifies an ERROR envelope with partial response through the provider error path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-native-json-partial-error-"));
    const homeDir = join(root, "home");
    const script = join(root, "agy-fixture");
    const events: BridgeEvent[] = [];
    await mkdir(homeDir, { recursive: true });
    await writeFile(script, `#!/usr/bin/env bash
printf '%s\\n' '{"conversation_id":"55555555-6666-7777-8888-999999999999","status":"ERROR","response":"partial answer that must not be delivered","error":"timeout waiting for response"}'
exit 1
`, { mode: 0o700 });

    try {
      let caught: (Error & { category?: string }) | null = null;
      try {
        await runAntigravitySerialized(
          script,
          ["--output-format", "json", "--print", "hello"],
          root,
          {
            bot: "antigravity",
            chatId: "telegram:interactive:partial-error",
            timeoutMs: 5_000,
            idleTimeoutMs: 5_000,
            eventContext: {
              runId: "native-json-partial-error",
              bot: "antigravity",
              chatId: "chat:partial-error",
            },
            onEvent: (event) => events.push(event),
          },
          { homeDir, model: null, applyModel: false, outputMode: "json" },
        );
      } catch (error) {
        caught = error as Error & { category?: string };
      }

      expect(caught?.message).toBe("Agy execution timed out waiting for response");
      expect(caught?.category).toBe("timeout");
      expect(events.filter((event) => event.type === "run.failed")).toMatchObject([{
        type: "run.failed",
        error: "Agy execution timed out waiting for response",
        category: "timeout",
      }]);
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
      expect(events.some((event) => event.type === "text.delta")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
