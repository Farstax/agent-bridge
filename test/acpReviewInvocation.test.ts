import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  buildAcpReviewEnvironment,
  buildReviewOutput,
  classifyAcpReviewFailure,
  classifyAcpReviewFailureFromEvidence,
  classifyUnavailableProviderStatus,
  collectSuccessfulToolKinds,
  createReviewCheckout,
  findReviewRunId,
  formatReviewResultFailure,
  joinReviewMessageParts,
  openReadOnlyReviewDatabase,
  qualifyReviewResult,
  readImplementingProvider,
  removeReviewCheckout,
  resolveImplementingRun,
  reviewRuntime,
  verifyReviewCheckout,
} from "../src/acpReview.js";
import { openDb } from "../src/db.js";

describe("ACP review invocation", () => {
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
        AGENT_BRIDGE_INSTALLATION_ID: "installation-1",
        AGENT_BRIDGE_RUN_ID: "implementer-run",
        AGENT_BRIDGE_LOCK_RUN_ID: "implementer-lock",
        AGENT_BRIDGE_OUTCOME_COMMAND: "/usr/local/bin/outcome",
        AGENT_BRIDGE_WAIT_COMMAND: "/usr/local/bin/wait",
        AGENT_BRIDGE_SCRATCH_COMMAND: "/usr/local/bin/scratch",
        AGENT_BRIDGE_CONTEXT_DB: "/var/lib/agent-bridge/context.sqlite",
        AGENT_BRIDGE_CHAT_KEY: "implementer-chat",
        AGENT_BRIDGE_OWNER_KEY: "implementer-owner",
        AGENT_BRIDGE_DELIVERY_CHAT_ID: "123",
      },
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
    expect(env.AGENT_BRIDGE_INSTALLATION_ID).toBe("installation-1");
    for (const key of [
      "AGENT_BRIDGE_RUN_ID", "AGENT_BRIDGE_LOCK_RUN_ID", "AGENT_BRIDGE_OUTCOME_COMMAND",
      "AGENT_BRIDGE_WAIT_COMMAND", "AGENT_BRIDGE_SCRATCH_COMMAND", "AGENT_BRIDGE_CONTEXT_DB",
      "AGENT_BRIDGE_CHAT_KEY", "AGENT_BRIDGE_OWNER_KEY", "AGENT_BRIDGE_DELIVERY_CHAT_ID",
    ]) expect(env[key]).toBeUndefined();
  });

  it("requires a configured durable Bridge database and uses the installed release runtime", () => {
    expect(() => buildAcpReviewEnvironment({
      provider: "claude",
      implementer: "codex",
      base: {},
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
      expect(reviewRuntime(pointer, "a".repeat(40))).toEqual({ root: release, commit: "b".repeat(40) });
      expect(() => reviewRuntime(pointer, "b".repeat(40))).toThrow(/independent of the candidate/);
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

  it("opens production review evidence without database write authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-review-readonly-db-"));
    const dbPath = join(root, "bridge.sqlite");
    const writable = openDb(dbPath, { serviceId: "acp:review-test", databaseRole: "interactive" });
    writable.close();
    const readonly = openReadOnlyReviewDatabase(dbPath);
    try {
      expect(() => readonly.prepare("INSERT INTO settings (key, value) VALUES ('review-test', 'write')").run()).toThrow(/readonly/i);
    } finally {
      readonly.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads completed review telemetry without opening the Bridge database for writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-review-readonly-db-"));
    const dbPath = join(root, "bridge.sqlite");
    const writable = openDb(dbPath, { serviceId: "acp:review-test", databaseRole: "interactive" });
    try {
      writable.raw.prepare("INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)")
        .run("session-1", "acp:conversation-1", "/tmp/review-test");
      writable.raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run("run-1", "acp:outward", "acp:conversation-1", "claude", "done", "2026-10-27T00:00:00Z");
    } finally {
      writable.close();
    }
    const readonly = openReadOnlyReviewDatabase(dbPath);
    try {
      expect(findReviewRunId(readonly, "session-1")).toBe("run-1");
      expect(() => readonly.prepare("INSERT INTO settings (key, value) VALUES ('review-test', 'write')").run()).toThrow(/readonly/i);
    } finally {
      readonly.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a same-provider review with a locked safe context and qualifies exact-head tool evidence", () => {
    const sameProviderEnv = buildAcpReviewEnvironment({
      provider: "codex",
      implementer: "codex",
      base: {
        DB_PATH: "/var/lib/agent-bridge/interactive/bridge.sqlite",
        AGENT_BRIDGE_RUN_ID: "implementer-run",
      },
      releaseDir: "/opt/agent-bridge/releases/current",
    });
    expect(sameProviderEnv.AGENT_BRIDGE_PROVIDER).toBe("codex");
    expect(sameProviderEnv.BRIDGE_PROVIDER_LOCK).toBe("codex");
    expect(sameProviderEnv.INTERACTIVE_CLI_CHAIN).toBe("codex");
    expect(sameProviderEnv.BRIDGE_EXECUTION_MODE).toBe("safe");
    expect(sameProviderEnv.CODEX_EXECUTION_MODE).toBe("safe");
    expect(sameProviderEnv.DB_PATH).toBe("/var/lib/agent-bridge/interactive/bridge.sqlite");
    expect(sameProviderEnv.AGENT_BRIDGE_RUN_ID).toBeUndefined();

    expect(qualifyReviewResult({
      text: `REVIEWED_HEAD: ${head}\nREVIEW_RESULT: PASS`,
      expectedHead: head,
      toolKinds: ["read", "search"],
    })).toEqual({ result: "pass", reviewedHead: head });
    const incomplete = qualifyReviewResult({
      text: `Actionable issue\nREVIEWED_HEAD: ${head}\nREVIEW_RESULT: FINDINGS`,
      expectedHead: head,
      toolKinds: [],
    });
    expect(incomplete).toEqual({
      result: "incomplete",
      failure: "missing tools",
      reviewerResult: "findings",
      missingToolKinds: ["read", "search"],
      reviewedHead: head,
    });
    expect(qualifyReviewResult({ text: "", expectedHead: head, toolKinds: [] })).toEqual({
      result: "incomplete",
      failure: "missing tools",
      reviewerResult: null,
      missingToolKinds: ["read", "search"],
      reviewedHead: null,
    });
    const output = JSON.parse(JSON.stringify(buildReviewOutput({
      implementer: "codex",
      provider: "claude",
      model: "provider-default",
      runtimeCommit: "b".repeat(40),
      bridgeRunId: "run-1",
      outwardSessionId: "session-1",
      providerSessionIds: ["inner-1"],
      qualified: incomplete,
      toolKinds: [],
      text: `Actionable issue\nREVIEWED_HEAD: ${head}\nREVIEW_RESULT: FINDINGS`,
    })));
    expect(output).toMatchObject({
      result: "incomplete",
      failure: "missing tools",
      reviewerResult: "findings",
      missingToolKinds: ["read", "search"],
      bridgeRunId: "run-1",
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

  it("qualifies Codex read-only repository commands from completed ACP execute events", () => {
    const updates = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sed -n '1,120p' src/acpReview.ts", cwd: "/candidate" },
      },
      { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "search-1",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "rg -n reviewPrompt src/acpReview.ts", cwd: "/candidate" },
      },
      { sessionUpdate: "tool_call_update", toolCallId: "search-1", status: "completed" },
    ] as unknown as acp.SessionUpdate[];
    expect(collectSuccessfulToolKinds(updates, "codex", "/candidate")).toEqual(["read", "search"]);
    expect(collectSuccessfulToolKinds(updates, "claude", "/candidate")).toEqual(["execute"]);

    const unsafe = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "chained",
        kind: "execute",
        status: "completed",
        rawInput: { command: "rg -n needle src && rm -f marker", cwd: "/candidate" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "outside",
        kind: "execute",
        status: "completed",
        rawInput: { command: "cat ../../private.txt", cwd: "/candidate" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "wrong-cwd",
        kind: "execute",
        status: "completed",
        rawInput: { command: "rg -n needle src", cwd: "/other" },
      },
    ] as unknown as acp.SessionUpdate[];
    expect(collectSuccessfulToolKinds(unsafe, "codex", "/candidate")).toEqual(["execute"]);
  });

  it("keeps final result markers on separate lines across ACP tool boundaries", () => {
    expect(joinReviewMessageParts([
      "The review found one issue.",
      null,
      `REVIEWED_HEAD: ${head}`,
      null,
      "REVIEW_RESULT: FINDINGS",
    ])).toBe(`The review found one issue.\nREVIEWED_HEAD: ${head}\nREVIEW_RESULT: FINDINGS`);
    expect(joinReviewMessageParts(["Text", " continues"])).toBe("Text continues");
  });

  it("keeps ACP launch, authentication, model, capacity, and review outcomes distinct", () => {
    expect(classifyAcpReviewFailure("spawn ENOENT")).toBe("launch");
    expect(classifyAcpReviewFailure("ACP review server exited before launch (1)")).toBe("launch");
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
    expect(formatReviewResultFailure("review result must contain exactly one qualified head and result"))
      .toBe("ACP reviewer review result failure: review result must contain exactly one qualified head and result");
  });

  it("ships a source-independent review entrypoint in the release artifact", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release-artifact.yml", import.meta.url), "utf8");
    const helper = readFileSync(new URL("../bin/agent-bridge-review", import.meta.url), "utf8");
    const skill = readFileSync(new URL("../skills/release-readiness-review/SKILL.md", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
    expect(workflow).toContain("bin/agent-bridge-review");
    expect(workflow).toContain('test -f "$verify_root/dist/acpReview.js"');
    expect(helper).toContain("$RELEASE_DIR/dist/acpReview.js");
    expect(helper).toContain('RELEASE_DIR="$(realpath -e "$(dirname "$(realpath -e "${BASH_SOURCE[0]}")")/..")"');
    expect(helper).not.toContain("${BRIDGE_CURRENT_RELEASE_DIR:-");
    expect(skill).toContain("$BRIDGE_CURRENT_RELEASE_DIR/bin/agent-bridge-review");
    expect(skill).not.toContain("npm run acp:review");
    expect(packageJson.scripts?.["acp:review"]).toBeUndefined();
  });
  it("reviews only the committed candidate tree and refuses a checkout that changes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "acp-review-repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "base");
      await writeFile(join(repo, "reviewed.txt"), "committed\n");
      git("add", "reviewed.txt");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "candidate");
      const candidate = git("rev-parse", "HEAD");
      // Dirty edits and untracked files with an unchanged HEAD.
      await writeFile(join(repo, "reviewed.txt"), "uncommitted\n");
      await writeFile(join(repo, "untracked.txt"), "untracked\n");
      expect(() => verifyReviewCheckout(repo, candidate)).toThrow(/changed during review/);

      const checkout = await createReviewCheckout(repo, candidate);
      try {
        expect(readFileSync(join(checkout, "reviewed.txt"), "utf8")).toBe("committed\n");
        expect(existsSync(join(checkout, "untracked.txt"))).toBe(false);
        expect(() => verifyReviewCheckout(checkout, candidate)).not.toThrow();
        await writeFile(join(checkout, "reviewed.txt"), "edited by reviewer\n");
        expect(() => verifyReviewCheckout(checkout, candidate)).toThrow(/changed during review/);
      } finally {
        await removeReviewCheckout(repo, checkout);
      }
      expect(existsSync(checkout)).toBe(false);
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
      await expect(createReviewCheckout(repo, "b".repeat(40))).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("binds the implementer to a Bridge-recorded ancestor process, not caller-controlled markers", () => {
    type Proc = { ppid: number; ticks: string; env: Record<string, string> };
    const procs = (table: Record<number, Proc>) =>
      (pid: number) => table[pid] ? { ppid: table[pid]!.ppid, startTicks: table[pid]!.ticks, environ: table[pid]!.env } : null;
    const recorded: Record<string, Array<{ bot: string; process?: { pid: number; startTicks: string } }>> = {
      "codex-run": [{ bot: "codex", process: { pid: 20, startTicks: "500" } }],
      "claude-run": [{ bot: "claude", process: { pid: 70, startTicks: "900" } }],
    };
    const starts = (dbPath: string, runId: string) => {
      if (dbPath !== "/db") throw new Error("unknown database");
      return recorded[runId] ?? [];
    };
    const bridge: Proc = { ppid: 1, ticks: "100", env: { DB_PATH: "/db" } };
    const codexAdapter: Proc = { ppid: 10, ticks: "500", env: { AGENT_BRIDGE_RUN_ID: "codex-run", AGENT_BRIDGE_PROVIDER: "codex", DB_PATH: "/db" } };

    // Relabelling the provider or Run below the recorded adapter does not change the implementer.
    expect(resolveImplementingRun(30, procs({
      10: bridge, 20: codexAdapter,
      30: { ppid: 20, ticks: "600", env: { AGENT_BRIDGE_RUN_ID: "claude-run", AGENT_BRIDGE_PROVIDER: "claude", DB_PATH: "/db" } },
    }), starts)).toEqual({ runId: "codex-run", dbPath: "/db", bot: "codex" });
    // An orphaned helper that forges another provider's running Run has no recorded ancestor.
    expect(() => resolveImplementingRun(30, procs({
      30: { ppid: 1, ticks: "950", env: { AGENT_BRIDGE_RUN_ID: "codex-run", AGENT_BRIDGE_PROVIDER: "codex", DB_PATH: "/db" } },
    }), starts)).toThrow(/cannot be established/);
    // PID reuse: same PID, different kernel start time.
    expect(() => resolveImplementingRun(20, procs({
      10: bridge, 20: { ...codexAdapter, ticks: "501" },
    }), starts)).toThrow(/cannot be established/);
    // A forged database path is not the recorded Run's database.
    expect(() => resolveImplementingRun(20, procs({
      10: bridge, 20: { ...codexAdapter, env: { ...codexAdapter.env, DB_PATH: "/forged.sqlite" } },
    }), starts)).toThrow(/cannot be established/);

    const db = openDb(":memory:", { serviceId: "acp:review-test", databaseRole: "interactive" });
    try {
      const insert = db.raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
        VALUES (?, 'telegram', 'chat', ?, ?, '2026-10-27T00:00:00Z')`);
      insert.run("codex-run", "codex", "running");
      insert.run("old-run", "claude", "done");
      const implementer = readImplementingProvider(db.raw, "codex-run", "codex");
      expect(implementer).toBe("codex");
      // Same-provider review is permitted, while the review receives a new Run context and remains locked safe.
      const sameProviderReview = buildAcpReviewEnvironment({
        provider: "codex", implementer, base: { DB_PATH: "/db", AGENT_BRIDGE_PROVIDER: "claude" },
        releaseDir: "/release",
      });
      expect(sameProviderReview.BRIDGE_PROVIDER_LOCK).toBe("codex");
      expect(sameProviderReview.AGENT_BRIDGE_PROVIDER).toBe("codex");
      expect(sameProviderReview.BRIDGE_EXECUTION_MODE).toBe("safe");
      expect(() => readImplementingProvider(db.raw, "codex-run", "claude")).toThrow(/inconsistent/);
      expect(() => readImplementingProvider(db.raw, "old-run", "claude")).toThrow(/not active/);
      expect(() => readImplementingProvider(db.raw, "missing", "codex")).toThrow(/not recorded/);
    } finally {
      db.close();
    }
  });

  it("bounds an unresponsive ACP server that ignores SIGTERM and cleans up the review checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-review-stall-"));
    const repo = join(root, "repo");
    const release = join(root, "release");
    const pidFile = join(root, "server.pid");
    const providerPidFile = pidFile + ".provider";
    const source = fileURLToPath(new URL("..", import.meta.url));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      await mkdir(repo);
      git("init", "--quiet");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "candidate");
      const candidate = git("rev-parse", "HEAD");
      // A release containing the helper; the runtime is located from the helper, not the environment.
      await cp(join(source, "src"), join(release, "src"), { recursive: true });
      await symlink(join(source, "node_modules"), join(release, "node_modules"));
      await writeFile(join(release, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(release, "dist/acpServer"), { recursive: true });
      await writeFile(join(release, "manifest.json"), JSON.stringify({ commit: "c".repeat(40) }));
      const cancelledFile = `${pidFile}.cancelled`;
      await writeFile(join(release, "dist/acpServer/stdio.js"), `import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
const pidFile = ${JSON.stringify(pidFile)};
const cancelledFile = ${JSON.stringify(cancelledFile)};
writeFileSync(pidFile, String(process.pid));
process.stdin.on("end", () => writeFileSync(pidFile + ".closed", ""));
const provider = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: "ignore" });
writeFileSync(pidFile + ".provider", String(provider.pid));
setInterval(() => {}, 1000);
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = acp.agent({ name: "stall-server" })
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: "stall-server", version: "1" } }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "stall-session" }))
  .onRequest(acp.methods.agent.session.prompt, () => new Promise(() => undefined))
  .onNotification(acp.methods.agent.session.cancel, ctx => writeFileSync(cancelledFile, ctx.params.sessionId))
  .connect(stream);
await connection.closed;
// Model the Bridge supervisor's bounded SIGTERM -> SIGKILL cleanup for a
// provider child in its own process group. The outer reviewer must let it finish.
await new Promise(resolve => setTimeout(resolve, Number(process.env.AGENT_BRIDGE_KILL_GRACE_MS ?? "5000") + 200));
try { process.kill(-provider.pid, "SIGKILL"); } catch {}
`);
      await writeFile(join(root, "prompt.md"), "Review it.\n");
      const dbPath = join(root, "bridge.sqlite");
      const db = openDb(dbPath, { serviceId: "acp:review-test", databaseRole: "interactive" });
      db.raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
        VALUES ('codex-run', 'telegram', 'chat', 'codex', 'running', '2026-10-27T00:00:00Z')`).run();
      db.close();
      // Stands in for the provider adapter Bridge spawned: it records its own
      // kernel identity as run.started, then runs the helper as a descendant.
      const out = join(root, "out.txt");
      const adapter = join(root, "adapter.mjs");
      await writeFile(adapter, `import { createRequire } from "node:module";
import { openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const Database = createRequire(${JSON.stringify(join(source, "package.json"))})("better-sqlite3");
const stat = readFileSync("/proc/" + process.pid + "/stat", "utf8");
const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const db = new Database(process.env.DB_PATH);
db.prepare("INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json) VALUES ('e1', 'codex-run', 1, 'run.started', '2026-10-27T00:00:00Z', ?)")
  .run(JSON.stringify({ type: "run.started", runId: "codex-run", bot: "codex", process: { pid: process.pid, startTicks } }));
db.close();
const fd = openSync(${JSON.stringify(out)}, "w");
spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(join(release, "src/acpReview.ts"))},
  "--provider", "claude", "--head", ${JSON.stringify(candidate)}, "--cwd", ${JSON.stringify(repo)},
  "--prompt-file", ${JSON.stringify(join(root, "prompt.md"))}, "--timeout-seconds", "2"],
  { cwd: ${JSON.stringify(release)}, env: { ...process.env, AGENT_BRIDGE_PROVIDER: "claude" }, stdio: ["ignore", fd, fd] });
`);
      const started = Date.now();
      execFileSync(process.execPath, [adapter], {
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME,
          AGENT_BRIDGE_RUN_ID: "codex-run", AGENT_BRIDGE_PROVIDER: "codex", DB_PATH: dbPath,
          AGENT_BRIDGE_KILL_GRACE_MS: "6500",
          BRIDGE_CURRENT_RELEASE_DIR: join(root, "caller-selected-release-is-ignored"),
        },
        timeout: 25_000,
      });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(readFileSync(out, "utf8")).toContain("ACP reviewer timed out after 2000ms (ACP session stall-session)");
      expect(readFileSync(cancelledFile, "utf8")).toBe("stall-session");
      // stdin closes after ACP cancellation, then bounded SIGTERM -> SIGKILL teardown.
      expect(existsSync(`${pidFile}.closed`)).toBe(true);
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      expect(alive(Number(readFileSync(providerPidFile, "utf8")))).toBe(false);
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    } finally {
      if (existsSync(providerPidFile)) {
        try { process.kill(-Number(readFileSync(providerPidFile, "utf8")), "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);

  it("completes a same-provider ACP review in a distinct Run and session with exact-head read/search evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-review-success-"));
    const repo = join(root, "repo");
    const release = join(root, "release");
    const source = fileURLToPath(new URL("..", import.meta.url));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      await mkdir(repo);
      git("init", "--quiet");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "candidate");
      const candidate = git("rev-parse", "HEAD");
      await cp(join(source, "src"), join(release, "src"), { recursive: true });
      await symlink(join(source, "node_modules"), join(release, "node_modules"));
      await writeFile(join(release, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(join(release, "manifest.json"), JSON.stringify({ commit: "c".repeat(40) }));
      await mkdir(join(release, "dist/acpServer"), { recursive: true });
      await writeFile(join(release, "dist/acpServer/stdio.js"), `import * as acp from "@agentclientprotocol/sdk";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
process.stderr.write = (chunk) => { appendFileSync(process.env.FIXTURE_LOG, chunk); return true; };
process.on("uncaughtException", error => { appendFileSync(process.env.FIXTURE_LOG, String(error.stack ?? error)); process.exit(1); });
const db = new Database(process.env.DB_PATH);
const sessionId = randomUUID();
const conversationId = randomUUID();
const runId = randomUUID();
db.prepare("INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)").run(sessionId, conversationId, process.cwd());
db.prepare("INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at) VALUES (?, 'acp:outward', ?, 'codex', 'done', '2026-10-28T00:00:00Z')").run(runId, conversationId);
db.close();
let reviewCwd = "";
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
acp.agent({ name: "fixture-review-runtime" })
  .onRequest(acp.methods.agent.initialize, async () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest(acp.methods.agent.session.new, async (ctx) => { reviewCwd = ctx.params.cwd; return { sessionId }; })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    writeFileSync(process.env.FIXTURE_PROMPT_CAPTURE, JSON.stringify(ctx.params.prompt));
    for (const [id, command] of [["read-1", "sed -n '1,120p' src/acpReview.ts"], ["search-1", "rg -n reviewPrompt src/acpReview.ts"]]) {
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "tool_call", toolCallId: id, title: "Codex command", kind: "execute", status: "in_progress", rawInput: { command, cwd: reviewCwd } } });
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" } });
    }
    await ctx.client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Independent repository review complete.\\nREVIEWED_HEAD: ${candidate}\\nREVIEW_RESULT: PASS" } } });
    return { stopReason: "end_turn" };
  })
  .connect(stream);
`);
      const promptFile = join(root, "prompt.md");
      await writeFile(promptFile, "Review the exact candidate and use repository read and search tools.\n");
      const dbPath = join(root, "bridge.sqlite");
      const db = openDb(dbPath, { serviceId: "acp:review-test", databaseRole: "interactive" });
      db.raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at, session_id)
        VALUES ('implementer-run', 'telegram', 'chat', 'codex', 'running', '2026-10-28T00:00:00Z', 'implementer-session')`).run();
      db.close();

      const outputPath = join(root, "review.json");
      const fixtureLog = join(root, "fixture.log");
      const fixturePrompt = join(root, "provider-prompt.json");
      const adapter = join(root, "adapter.mjs");
      await writeFile(adapter, `import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const Database = createRequire(${JSON.stringify(join(source, "package.json"))})("better-sqlite3");
const stat = readFileSync("/proc/" + process.pid + "/stat", "utf8");
const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const db = new Database(process.env.DB_PATH);
db.prepare("INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json) VALUES ('implementer-start', 'implementer-run', 1, 'run.started', '2026-10-28T00:00:00Z', ?)")
  .run(JSON.stringify({ type: "run.started", runId: "implementer-run", bot: "codex", process: { pid: process.pid, startTicks } }));
db.close();
const result = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(join(release, "src/acpReview.ts"))},
  "--provider", "codex", "--head", ${JSON.stringify(candidate)}, "--cwd", ${JSON.stringify(repo)}, "--prompt-file", ${JSON.stringify(promptFile)}],
  { cwd: ${JSON.stringify(release)}, env: { ...process.env, AGENT_BRIDGE_PROVIDER: "codex" }, encoding: "utf8", timeout: 25_000 });
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
if (result.error) throw result.error;
`);
      execFileSync(process.execPath, [adapter], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DB_PATH: dbPath, FIXTURE_LOG: fixtureLog, FIXTURE_PROMPT_CAPTURE: fixturePrompt, AGENT_BRIDGE_RUN_ID: "implementer-run", AGENT_BRIDGE_PROVIDER: "codex" },
        timeout: 30_000,
      });

      const output = JSON.parse(readFileSync(outputPath, "utf8")) as { status: number; stdout: string; stderr: string };
      const diagnostics = existsSync(fixtureLog) ? readFileSync(fixtureLog, "utf8") : "";
      expect(output.status, `${output.stdout}\n${output.stderr}\n${diagnostics}`).toBe(0);
      const evidence = JSON.parse(output.stdout) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        implementer: "codex",
        provider: "codex",
        result: "pass",
        reviewedHead: candidate,
        toolKinds: ["read", "search"],
      });
      expect(evidence.bridgeRunId).toMatch(/^[a-f0-9-]{36}$/);
      expect(typeof evidence.outwardSessionId).toBe("string");
      expect(evidence.outwardSessionId).toMatch(/^[a-f0-9-]{36}$/);
      expect(evidence.bridgeRunId).not.toBe("implementer-run");
      expect(evidence.outwardSessionId).not.toBe("implementer-session");
      expect(evidence.text).toContain(`REVIEWED_HEAD: ${candidate}`);
      const sentPrompt = JSON.parse(readFileSync(fixturePrompt, "utf8")) as Array<{ text?: string }>;
      expect(sentPrompt.map((part) => part.text ?? "").join(" ")).toContain("one command per call and no shell operators or command chaining");
      expect(sentPrompt.map((part) => part.text ?? "").join(" ")).not.toContain("Do not use shell/Bash/execute as a substitute");
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
});
