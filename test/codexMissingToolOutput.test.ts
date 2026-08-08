import { describe, expect, it } from "vitest";
import { runCli, runCliAsync } from "../src/cli.js";
import type { BridgeEvent } from "../src/events/types.js";

const MISSING_TOOL_OUTPUT =
  "ERROR codex_core::util: Custom tool call output is missing for call id: call_stale\n";
const FINAL_RESPONSE = `${JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "completed normally" },
})}\n`;
const NON_FINAL_OUTPUT = `${JSON.stringify({
  type: "thread.started",
  thread_id: "019fce12-b227-7563-b9a8-41dfc5ba1b15",
})}\n`;
const DELTA_ONLY_OUTPUT = `${JSON.stringify({
  type: "response.output_text.delta",
  delta: "partial output",
})}\n`;

type Runner = (script: string, events: BridgeEvent[], runId: string) => Promise<string>;

function childScript(stderr: string, stdout: string): string {
  return [
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
  ].join("");
}

function options(events: BridgeEvent[], runId: string) {
  return {
    bot: "codex" as const,
    bypassWorkspaceLock: true,
    eventContext: { runId, bot: "codex" as const, chatId: "123" },
    onEvent: (event: BridgeEvent) => events.push(event),
  };
}

const runners: Array<{ name: string; run: Runner }> = [
  {
    name: "runCli",
    run: (script, events, runId) =>
      runCli(process.execPath, ["-e", script], process.cwd(), options(events, runId)),
  },
  {
    name: "runCliAsync",
    run: async (script, events, runId) =>
      (await runCliAsync(process.execPath, ["-e", script], process.cwd(), options(events, runId))).text,
  },
];

function terminalEvents(events: BridgeEvent[]): BridgeEvent[] {
  return events.filter((event) =>
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

describe.each(runners)("Codex missing custom-tool output classification via $name", ({ run }) => {
  it("preserves a successful final response despite the stale-session diagnostic", async () => {
    const events: BridgeEvent[] = [];
    const stdout = await run(
      childScript(MISSING_TOOL_OUTPUT, FINAL_RESPONSE),
      events,
      `codex-warning-success-${Math.random()}`,
    );

    expect(stdout).toContain("completed normally");
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["run.completed"]);
  });

  it("fails an exit-zero turn when the exact diagnostic has no usable final response", async () => {
    const events: BridgeEvent[] = [];
    const execution = run(
      childScript(MISSING_TOOL_OUTPUT, NON_FINAL_OUTPUT),
      events,
      `codex-warning-empty-${Math.random()}`,
    );

    await expect(execution).rejects.toThrow(/custom tool call output is missing/i);
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["run.failed"]);
  });

  it("does not treat a text delta as a completed final response", async () => {
    const events: BridgeEvent[] = [];
    const execution = run(
      childScript(MISSING_TOOL_OUTPUT, DELTA_ONLY_OUTPUT),
      events,
      `codex-warning-delta-only-${Math.random()}`,
    );

    await expect(execution).rejects.toThrow(/custom tool call output is missing/i);
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["run.failed"]);
  });

  it("does not fail an ordinary exit-zero Codex stderr diagnostic", async () => {
    const events: BridgeEvent[] = [];
    const stdout = await run(
      childScript("WARN codex_core::util: unrelated diagnostic\n", NON_FINAL_OUTPUT),
      events,
      `codex-ordinary-stderr-${Math.random()}`,
    );

    expect(stdout).toContain("thread.started");
    expect(terminalEvents(events).map((event) => event.type)).toEqual(["run.completed"]);
  });
});
