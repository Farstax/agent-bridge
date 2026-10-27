import { describe, expect, it } from "vitest";
import {
  buildAcpReviewEnvironment,
  qualifyReviewResult,
} from "../scripts/acp-review.js";

describe("cross-provider ACP review invocation", () => {
  const head = "a".repeat(40);
  it("locks the requested reviewer and safe-mode permissions without changing the active provider", () => {
    const env = buildAcpReviewEnvironment({
      provider: "claude",
      implementer: "codex",
      base: {
        INTERACTIVE_CLI_CHAIN: "codex,claude",
        BRIDGE_EXECUTION_MODE: "trusted",
        CLAUDE_MODEL_PREFERENCE: "unavailable-model",
        CLAUDE_COMMAND: "native-login-failing-command",
      },
      dbPath: "/tmp/review/bridge.sqlite",
      projectDir: "/workspace/repo",
    });

    expect(env.AGENT_BRIDGE_PROVIDER).toBe("codex");
    expect(env.BRIDGE_PROVIDER_LOCK).toBe("claude");
    expect(env.INTERACTIVE_CLI_CHAIN).toBe("claude");
    expect(env.BRIDGE_EXECUTION_MODE).toBe("safe");
    expect(env.CLAUDE_EXECUTION_MODE).toBe("safe");
    expect(env.DB_PATH).toBe("/tmp/review/bridge.sqlite");
    expect(env.CLAUDE_MODEL_PREFERENCE).toBeUndefined();
    expect(env.CLAUDE_COMMAND).toBe("native-login-failing-command");
  });

  it("refuses same-provider reviews and only qualifies an exact-head PASS with read/search tool evidence", () => {
    expect(() => buildAcpReviewEnvironment({
      provider: "codex",
      implementer: "codex",
      base: {},
      dbPath: "/tmp/review/bridge.sqlite",
      projectDir: "/workspace/repo",
    })).toThrow(/different provider/);

    expect(qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read"],
    })).toEqual({ result: "pass", reviewedHead: head });
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${"b".repeat(40)}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toThrow(/exact candidate/);
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: [],
    })).toThrow(/read\/search tools/);
  });
});
