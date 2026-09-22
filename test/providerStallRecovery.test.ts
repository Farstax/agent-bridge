import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CliTimeoutError,
  ProviderStallError,
  runSupervisedStdioSession,
} from "../src/cli.js";
import type { BridgeEvent } from "../src/events/types.js";

const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-stall-supervisor-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("ACP provider stall supervision", () => {
  it("classifies stdio inactivity as recoverable and does not emit run.failed", async () => {
    const events: BridgeEvent[] = [];
    let caught: unknown;
    try {
      await runSupervisedStdioSession(
        process.execPath,
        ["-e", "setTimeout(() => {}, 5000)"],
        cwd,
        {
          bot: "codex",
          idleTimeoutMs: 80,
          timeoutMs: 2_000,
          killGraceMs: 25,
          eventContext: { runId: "stall-1", bot: "codex", chatId: "1", chatKey: "1" },
          onEvent: (event) => events.push(event),
        },
        ({ signal }) => waitForAbort(signal),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderStallError);
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
  });

  it("does not treat stderr chatter as ACP liveness", async () => {
    const started = Date.now();
    await expect(
      runSupervisedStdioSession(
        process.execPath,
        ["-e", "setInterval(() => process.stderr.write('noise\\n'), 20)"],
        cwd,
        { bot: "codex", idleTimeoutMs: 100, timeoutMs: 2_000, killGraceMs: 25 },
        ({ signal }) => waitForAbort(signal),
      ),
    ).rejects.toBeInstanceOf(ProviderStallError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("treats ACP stdout protocol traffic as liveness", async () => {
    await expect(
      runSupervisedStdioSession(
        process.execPath,
        ["-e", "let n=0; const t=setInterval(()=>{process.stdout.write('x'); if(++n===5){clearInterval(t);}},40); setTimeout(()=>{},5000)"],
        cwd,
        { bot: "codex", idleTimeoutMs: 100, timeoutMs: 2_000, killGraceMs: 25 },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 180));
          return "alive";
        },
      ),
    ).resolves.toBe("alive");
  });

  it("keeps hard timeout terminal and distinct", async () => {
    let caught: unknown;
    try {
      await runSupervisedStdioSession(
        process.execPath,
        ["-e", "setInterval(()=>process.stdout.write('x'),20)"],
        cwd,
        { bot: "codex", idleTimeoutMs: 500, timeoutMs: 100, killGraceMs: 25 },
        ({ signal }) => waitForAbort(signal),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliTimeoutError);
    expect((caught as CliTimeoutError).timeoutKind).toBe("hard");
  });
});
