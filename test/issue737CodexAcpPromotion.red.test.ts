import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

const originalRuntime = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
const originalCommand = process.env.CODEX_ACP_COMMAND;

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
  else process.env.AGENT_BRIDGE_CODEX_RUNTIME = originalRuntime;
  if (originalCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
  else process.env.CODEX_ACP_COMMAND = originalCommand;
});

describe("Codex ACP production promotion", () => {
  it("uses the managed ACP adapter for ordinary Codex execution without a runtime selector", () => {
    delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
    process.env.CODEX_ACP_COMMAND = "/opt/agent-bridge/node_modules/.bin/codex-acp";

    const invocation = buildCliInvocation({
      bot: "codex",
      prompt: "ship it",
      sessionId: null,
      command: "codex",
      model: "gpt-5.6-sol",
      executionMode: "safe",
    });

    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.command).toBe("/opt/agent-bridge/node_modules/.bin/codex-acp");
    expect(invocation.args).toEqual([]);
  });
});
