import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";

const SILENT_EXIT = "CLI exited with code 1: (no diagnostic output)";

describe("issue #643 Claude circuit breaker", () => {
  let root: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-bridge-643-breaker-"));
    db = openDb(join(root, "bridge.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function makeClaudeEngine(): BridgeEngine {
    return new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      },
      db,
      {} as any,
      {},
    );
  }

  function acquire(chatKey = "100") {
    const handle = db.acquireLock("test", chatKey);
    expect(handle).not.toBeNull();
    return handle!;
  }

  it("retires a Claude session after two consecutive silent exit-1 failures while resuming", () => {
    db.setSession("100", "claude", "session-643");
    const engine = makeClaudeEngine();
    const handle = acquire();

    (engine as any)._handleCircuitBreaker(new Error(SILENT_EXIT), "100", handle);
    expect(db.getSession("100", "claude")).toBe("session-643");

    (engine as any)._handleCircuitBreaker(new Error(SILENT_EXIT), "100", handle);
    expect(db.getSession("100", "claude")).toBeNull();
  });

  it("does not retire a resumed session for ordinary exit-1 diagnostics", () => {
    db.setSession("100", "claude", "session-643");
    const engine = makeClaudeEngine();
    const handle = acquire();

    for (let i = 0; i < 3; i += 1) {
      (engine as any)._handleCircuitBreaker(new Error("CLI exited with code 1: authentication failed"), "100", handle);
    }

    expect(db.getSession("100", "claude")).toBe("session-643");
  });

  it("does not count silent exit-1 failures from fresh Claude turns", () => {
    const engine = makeClaudeEngine();
    const handle = acquire();

    (engine as any)._handleCircuitBreaker(new Error(SILENT_EXIT), "100", handle);
    (engine as any)._handleCircuitBreaker(new Error(SILENT_EXIT), "100", handle);

    db.setSession("100", "claude", "new-session");
    (engine as any)._handleCircuitBreaker(new Error(SILENT_EXIT), "100", handle);
    expect(db.getSession("100", "claude")).toBe("new-session");
  });

  it("resets the consecutive-failure counter after a successful Claude turn", () => {
    db.setSession("100", "claude", "session-643");
    const engine = makeClaudeEngine();
    const handle = acquire();

    (engine as any)._handleCircuitBreaker(new Error(SILENT_EXIT), "100", handle);
    (engine as any)._commitResultState(handle, "recovered", {
      text: "ok",
      sessionId: "session-643",
      nativeSessionMode: "resume",
    });
    (engine as any)._handleCircuitBreaker(new Error(SILENT_EXIT), "100", handle);

    expect(db.getSession("100", "claude")).toBe("session-643");
  });
});
