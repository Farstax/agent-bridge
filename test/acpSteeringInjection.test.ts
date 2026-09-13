import { describe, expect, it } from "vitest";
import { runAcpTurn, type AcpSteerFn } from "../src/acp/index.js";
import { createFakeAcpAgent } from "./support/fakeAcpAgent.js";

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ACP mid-turn steering", () => {
  it("injects a follow-up message into a live turn instead of starting a new one", async () => {
    let steer: AcpSteerFn | undefined;
    const abort = new AbortController();

    const hung = runAcpTurn({
      peer: createFakeAcpAgent({ steeringSupported: true }),
      cwd: process.cwd(),
      conversationId: "conv-steer-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "HANG",
      executionMode: "trusted",
      signal: abort.signal,
      onSteerReady: (fn) => {
        steer = fn;
      },
    });

    await waitFor(() => steer !== undefined);
    const outcome = await steer!("steered message");
    expect(outcome).toEqual({ outcome: "injected" });

    abort.abort();
    const result = await hung;
    expect(result.stopReason).toBe("cancelled");
    expect(result.liveText).toContain("steered:steered message");
  });

  it("does not expose a steering handle when the live agent does not advertise support", async () => {
    let steerReadyCalled = false;
    const abort = new AbortController();

    const hung = runAcpTurn({
      peer: createFakeAcpAgent(),
      cwd: process.cwd(),
      conversationId: "conv-steer-2",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "HANG",
      executionMode: "trusted",
      signal: abort.signal,
      onSteerReady: () => {
        steerReadyCalled = true;
      },
    });

    setTimeout(() => abort.abort(), 20);
    const result = await hung;
    expect(result.stopReason).toBe("cancelled");
    expect(steerReadyCalled).toBe(false);
  });
});
