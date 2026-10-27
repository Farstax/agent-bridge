import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAcpReviewEnvironment,
  classifyAcpReviewFailure,
  collectSuccessfulToolKinds,
  findReviewRunId,
  qualifyReviewResult,
  reviewRuntime,
} from "../src/acpReview.js";

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
        DB_PATH: "/var/lib/agent-bridge/interactive/bridge.sqlite",
      },
      projectDir: "/workspace/repo",
      releaseDir: "/opt/agent-bridge/releases/current",
    });

    expect(env.AGENT_BRIDGE_PROVIDER).toBe("codex");
    expect(env.BRIDGE_PROVIDER_LOCK).toBe("claude");
    expect(env.INTERACTIVE_CLI_CHAIN).toBe("claude");
    expect(env.BRIDGE_EXECUTION_MODE).toBe("safe");
    expect(env.CLAUDE_EXECUTION_MODE).toBe("safe");
    expect(env.DB_PATH).toBe("/var/lib/agent-bridge/interactive/bridge.sqlite");
    expect(env.CLAUDE_MODEL_PREFERENCE).toBeUndefined();
    expect(env.CLAUDE_COMMAND).toBeUndefined();
  });

  it("requires a configured durable Bridge database and uses the installed release runtime", () => {
    expect(() => buildAcpReviewEnvironment({
      provider: "claude",
      implementer: "codex",
      base: {},
      projectDir: "/workspace/repo",
      releaseDir: "/opt/agent-bridge/releases/current",
    })).toThrow(/DB_PATH/);
  });

  it("selects only a manifest-bound installed release distinct from the candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-review-runtime-"));
    try {
      await mkdir(join(root, "dist/acpServer"), { recursive: true });
      await writeFile(join(root, "manifest.json"), JSON.stringify({ commit: "b".repeat(40) }));
      await writeFile(join(root, "dist/acpServer/stdio.js"), "");
      expect(reviewRuntime({ BRIDGE_CURRENT_RELEASE_DIR: root }, "a".repeat(40))).toEqual({ root, commit: "b".repeat(40) });
      expect(() => reviewRuntime({ BRIDGE_CURRENT_RELEASE_DIR: root }, "b".repeat(40))).toThrow(/independent of the candidate/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("correlates the Bridge run through the durable outward-session conversation identity", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE outward_acp_sessions (session_id TEXT, conversation_id TEXT);
        CREATE TABLE bridge_runs (run_id TEXT, surface_identity TEXT, chat_id TEXT, started_at TEXT);
        INSERT INTO outward_acp_sessions VALUES ('session-1', 'acp:conversation-1');
        INSERT INTO bridge_runs VALUES ('run-1', 'acp:outward', 'acp:conversation-1', '2026-10-27');`);
      expect(findReviewRunId(db, "session-1")).toBe("run-1");
    } finally {
      db.close();
    }
  });

  it("refuses same-provider reviews and only qualifies an exact-head PASS with read/search tool evidence", () => {
    expect(() => buildAcpReviewEnvironment({
      provider: "codex",
      implementer: "codex",
      base: {},
      projectDir: "/workspace/repo",
      releaseDir: "/opt/agent-bridge/releases/current",
    })).toThrow(/different provider/);

    expect(qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toEqual({ result: "pass", reviewedHead: head });
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nExample: REVIEW_RESULT: PASS\nREVIEWED_HEAD: ${head}\nREVIEW_RESULT: FINDINGS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toThrow(/exactly one/);
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS\nREVIEW_RESULT: FINDINGS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toThrow(/exactly one/);
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${"b".repeat(40)}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toThrow(/exact candidate/);
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: [],
    })).toThrow(/repository read tool/);
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read"],
    })).toThrow(/repository search tool/);
  });

  it("requires a completed read or search tool call", () => {
    expect(collectSuccessfulToolKinds([
      { sessionUpdate: "tool_call", toolCallId: "denied", kind: "read", status: "failed" },
      { sessionUpdate: "tool_call_update", toolCallId: "success", kind: "search", status: "completed" },
    ])).toEqual(["search"]);
    expect(collectSuccessfulToolKinds([
      { sessionUpdate: "tool_call", toolCallId: "read-1", kind: "read", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" },
    ])).toEqual(["read"]);
  });

  it("keeps ACP launch, authentication, model, capacity, and review outcomes distinct", () => {
    expect(classifyAcpReviewFailure("spawn ENOENT")).toBe("launch");
    expect(classifyAcpReviewFailure("authentication required by ACP adapter")).toBe("authentication");
    expect(classifyAcpReviewFailure("unsupported model before prompt submission")).toBe("unsupported model");
    expect(classifyAcpReviewFailure("model not found by ACP provider")).toBe("unsupported model");
    expect(classifyAcpReviewFailure("You've hit your session limit")).toBe("capacity");
    expect(classifyAcpReviewFailure("no available provider in the configured chain")).toBe("provider unavailable");
    expect(classifyAcpReviewFailure("REVIEW_RESULT: FINDINGS")).toBeNull();
  });

  it("ships a source-independent review entrypoint in the release artifact", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release-artifact.yml", import.meta.url), "utf8");
    const helper = readFileSync(new URL("../bin/agent-bridge-review", import.meta.url), "utf8");
    const skill = readFileSync(new URL("../skills/release-readiness-review/SKILL.md", import.meta.url), "utf8");
    expect(workflow).toContain("bin/agent-bridge-review");
    expect(workflow).toContain('test -f "$verify_root/dist/acpReview.js"');
    expect(helper).toContain("$RELEASE_DIR/dist/acpReview.js");
    expect(helper).toContain('export BRIDGE_CURRENT_RELEASE_DIR="$RELEASE_DIR"');
    expect(skill).toContain("$BRIDGE_CURRENT_RELEASE_DIR/bin/agent-bridge-review");
    expect(skill).not.toContain("npm run acp:review --");
  });
});
