import { describe, expect, it } from "vitest";
import { runAcpSessionSetup } from "../src/acp/index.js";
import { createFakeAcpAgent } from "./support/fakeAcpAgent.js";

describe("ACP config discovery", () => {
  it("negotiates session configuration without dispatching a prompt", async () => {
    const result = await runAcpSessionSetup({
      peer: createFakeAcpAgent({ loadSession: true, close: true }),
      cwd: process.cwd(),
      conversationId: "config-control:codex:chat-1",
      runId: "config-control-run-1",
      existingAcpSessionId: null,
      executionMode: "safe",
    });

    expect(result.sessionMode).toBe("fresh");
    expect(result.acpSessionId).toMatch(/^acp-/);
    expect(result.liveText).toBe("");
    expect(result.events).toEqual([]);
    expect(result.updates).toEqual([]);
    expect(result.configOptions.some((option) => option.id === "effort")).toBe(true);
    expect(result.usage).toBeUndefined();
  });
});
