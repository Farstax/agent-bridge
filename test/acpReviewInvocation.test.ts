import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAcpReviewEnvironment,
  classifyAcpReviewFailure,
  classifyAcpReviewFailureFromEvidence,
  classifyUnavailableProviderStatus,
  collectSuccessfulToolKinds,
  findReviewRunId,
  qualifyReviewResult,
  reviewRuntime,
} from "../src/acpReview.js";
import { openDb } from "../src/db.js";

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
    expect(env.BRIDGE_PROJECT_DIR).toBe("/opt/agent-bridge/releases/current");
    expect(env.BRIDGE_ACP_REVIEW_MODE).toBe("1");
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
    const pointer = join(root, "current");
    const release = join(root, "release");
    try {
      await mkdir(join(release, "dist/acpServer"), { recursive: true });
      await writeFile(join(release, "manifest.json"), JSON.stringify({ commit: "b".repeat(40) }));
      await writeFile(join(release, "dist/acpServer/stdio.js"), "");
      await symlink(release, pointer);
      expect(reviewRuntime({ BRIDGE_CURRENT_RELEASE_DIR: pointer }, "a".repeat(40))).toEqual({ root: release, commit: "b".repeat(40) });
      expect(() => reviewRuntime({ BRIDGE_CURRENT_RELEASE_DIR: pointer }, "b".repeat(40))).toThrow(/independent of the candidate/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("correlates the Bridge run through the durable outward-session conversation identity", () => {
    const db = openDb(":memory:", { serviceId: "acp:review-test", databaseRole: "interactive" });
    try {
      db.raw.prepare("INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)")
        .run("session-1", "acp:conversation-1", "/tmp/review-test");
      db.raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run("run-1", "acp:outward", "acp:conversation-1", "claude", "done", "2026-10-27T00:00:00Z");
      expect(findReviewRunId(db.raw, "session-1")).toBe("run-1");
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
    expect(qualifyReviewResult({
      text: `Actionable issue\nREVIEWED_HEAD: ${head}\nREVIEW_RESULT: FINDINGS`,
      expectedHead: head,
      toolKinds: [],
    })).toEqual({
      result: "incomplete",
      failure: "missing tools",
      reviewerResult: "findings",
      missingToolKinds: ["read", "search"],
      reviewedHead: head,
    });
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
      text: `REVIEWED_HEAD: ${head}\nSummary text after the head\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toThrow(/final two lines/);
    expect(() => qualifyReviewResult({
      text: `REVIEWED_HEAD: ${"b".repeat(40)}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toThrow(/exact candidate/);
    expect(qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: [],
    })).toMatchObject({ result: "incomplete", failure: "missing tools", missingToolKinds: ["read", "search"] });
    expect(qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read"],
    })).toMatchObject({ result: "incomplete", failure: "missing tools", missingToolKinds: ["search"] });
    expect(qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["search"],
    })).toMatchObject({ result: "incomplete", failure: "missing tools", missingToolKinds: ["read"] });
  });

  it("records completed read and search tool calls", () => {
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
    expect(classifyAcpReviewFailure("unsupported outward ACP provider lock: claude")).toBe("provider unavailable");
    expect(classifyAcpReviewFailureFromEvidence("outward ACP prompt execution failed", "startup OAuth warning\nACP server spawn ENOENT")).toBe("launch");
    expect(classifyUnavailableProviderStatus({ runtimeAvailable: true, credentialAvailable: false, authenticationDegraded: false })).toBe("authentication");
    expect(classifyUnavailableProviderStatus({ runtimeAvailable: false, credentialAvailable: true, authenticationDegraded: false })).toBe("launch");
    expect(classifyAcpReviewFailure("REVIEW_RESULT: FINDINGS")).toBeNull();
  });

  it("ships a source-independent review entrypoint in the release artifact", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release-artifact.yml", import.meta.url), "utf8");
    const helper = readFileSync(new URL("../bin/agent-bridge-review", import.meta.url), "utf8");
    const skill = readFileSync(new URL("../skills/release-readiness-review/SKILL.md", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
    expect(workflow).toContain("bin/agent-bridge-review");
    expect(workflow).toContain('test -f "$verify_root/dist/acpReview.js"');
    expect(helper).toContain("$RELEASE_DIR/dist/acpReview.js");
    expect(helper).toContain('export BRIDGE_CURRENT_RELEASE_DIR="$RELEASE_DIR"');
    expect(skill).toContain("$BRIDGE_CURRENT_RELEASE_DIR/bin/agent-bridge-review");
    expect(skill).not.toContain("npm run acp:review");
    expect(packageJson.scripts?.["acp:review"]).toBeUndefined();
  });
});
