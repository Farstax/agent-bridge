import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
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
    expect(helper).toContain('RELEASE_DIR="$(realpath -e "$RELEASE_DIR")"');
    expect(helper).toContain('export BRIDGE_CURRENT_RELEASE_DIR="$RELEASE_DIR"');
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

  it("derives the implementer from the Bridge-started ancestor, not caller-controlled environment", () => {
    const procs = (table: Record<number, { ppid: number; env: Record<string, string> }>) =>
      (pid: number) => table[pid] ? { ppid: table[pid]!.ppid, environ: table[pid]!.env } : null;
    const bridge = { ppid: 1, env: { DB_PATH: "/db" } };
    const adapter = { ppid: 10, env: { AGENT_BRIDGE_RUN_ID: "codex-run", AGENT_BRIDGE_PROVIDER: "codex", DB_PATH: "/db" } };

    // A shell that only relabels the provider still resolves to the real Run.
    expect(resolveImplementingRun(30, procs({
      10: bridge, 20: adapter,
      30: { ppid: 20, env: { AGENT_BRIDGE_RUN_ID: "codex-run", AGENT_BRIDGE_PROVIDER: "claude", DB_PATH: "/db" } },
    }))).toEqual({ runId: "codex-run", dbPath: "/db" });
    // Relabelling the Run or database below the Bridge-started process fails closed.
    expect(() => resolveImplementingRun(30, procs({
      10: bridge, 20: adapter,
      30: { ppid: 20, env: { AGENT_BRIDGE_RUN_ID: "claude-run", AGENT_BRIDGE_PROVIDER: "claude", DB_PATH: "/db" } },
    }))).toThrow(/inconsistent/);
    expect(() => resolveImplementingRun(30, procs({
      10: bridge, 20: adapter,
      30: { ppid: 20, env: { AGENT_BRIDGE_RUN_ID: "codex-run", DB_PATH: "/forged.sqlite" } },
    }))).toThrow(/inconsistent/);
    // No Bridge-started ancestor at all.
    expect(() => resolveImplementingRun(30, procs({
      30: { ppid: 1, env: { AGENT_BRIDGE_PROVIDER: "codex" } },
    }))).toThrow(/cannot be established/);

    const db = openDb(":memory:", { serviceId: "acp:review-test", databaseRole: "interactive" });
    try {
      const insert = db.raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
        VALUES (?, 'telegram', 'chat', ?, ?, '2026-10-27T00:00:00Z')`);
      insert.run("codex-run", "codex", "running");
      insert.run("old-run", "claude", "done");
      const implementer = readImplementingProvider(db.raw, "codex-run");
      expect(implementer).toBe("codex");
      // Asking Codex to review its own Run fails regardless of a spoofed AGENT_BRIDGE_PROVIDER.
      expect(() => buildAcpReviewEnvironment({
        provider: "codex", implementer, base: { DB_PATH: "/db", AGENT_BRIDGE_PROVIDER: "claude" },
        projectDir: "/repo", releaseDir: "/release",
      })).toThrow(/different provider/);
      expect(() => readImplementingProvider(db.raw, "old-run")).toThrow(/not active/);
      expect(() => readImplementingProvider(db.raw, "missing")).toThrow(/not recorded/);
    } finally {
      db.close();
    }
  });

  it("bounds an unresponsive ACP server that ignores SIGTERM and cleans up the review checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-review-stall-"));
    const repo = join(root, "repo");
    const release = join(root, "release");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      await mkdir(repo);
      git("init", "--quiet");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "candidate");
      const candidate = git("rev-parse", "HEAD");
      await mkdir(join(release, "dist/acpServer"), { recursive: true });
      await writeFile(join(release, "manifest.json"), JSON.stringify({ commit: "c".repeat(40) }));
      const pidFile = join(root, "server.pid");
      await writeFile(join(release, "dist/acpServer/stdio.js"),
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
process.stdin.on("end", () => require("fs").writeFileSync(${JSON.stringify(pidFile)} + ".closed", "")).resume();\n`);
      await writeFile(join(release, "package.json"), JSON.stringify({ type: "commonjs" }));
      await writeFile(join(root, "prompt.md"), "Review it.\n");
      const dbPath = join(root, "bridge.sqlite");
      const db = openDb(dbPath, { serviceId: "acp:review-test", databaseRole: "interactive" });
      db.raw.prepare(`INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at)
        VALUES ('codex-run', 'telegram', 'chat', 'codex', 'running', '2026-10-27T00:00:00Z')`).run();
      db.close();

      const helper = fileURLToPath(new URL("../src/acpReview.ts", import.meta.url));
      const out = join(root, "out.txt");
      // Detach through a short-lived shell so the helper's only Bridge-marked
      // ancestry is its own exec-time environment, as under a Bridge provider.
      const launcher = spawn("/bin/sh", ["-c", `"$@" >${JSON.stringify(out)} 2>&1 & echo $!`, "sh",
        process.execPath, "--import", "tsx", helper,
        "--provider", "claude", "--head", candidate, "--cwd", repo,
        "--prompt-file", join(root, "prompt.md"), "--timeout-seconds", "2"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME,
          AGENT_BRIDGE_RUN_ID: "codex-run", AGENT_BRIDGE_PROVIDER: "claude", DB_PATH: dbPath,
          BRIDGE_CURRENT_RELEASE_DIR: release,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let helperPid = "";
      launcher.stdout.on("data", (chunk: Buffer) => { helperPid += chunk.toString(); });
      await new Promise((resolveExit) => launcher.once("exit", resolveExit));
      const started = Date.now();
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (alive(Number(helperPid.trim())) && Date.now() - started < 20_000) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      expect(alive(Number(helperPid.trim()))).toBe(false);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(readFileSync(out, "utf8")).toContain("ACP reviewer timed out after 2000ms");
      // stdin closed first so a real server can finalize its Run, then forced stop.
      expect(existsSync(`${pidFile}.closed`)).toBe(true);
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
