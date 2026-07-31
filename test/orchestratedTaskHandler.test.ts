import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createOrchestratedTaskHandler } from "../src/handlers/orchestratedTask.js";
import { WORKER_BLOCKED_RESULT_MARKER } from "../src/workerBlockedResult.js";

function makeDb() {
  const dbPath = join(tmpdir(), `orchestrated-task-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

function makeStubs() {
  return {
    runCli: vi.fn().mockResolvedValue("1. Inspect\n2. Edit\n3. Test"),
    runGit: vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) return "src/fix.ts\n";
      return "";
    }),
    runTests: vi.fn().mockResolvedValue({ ok: true, output: "Tests passed." }),
  };
}

function blockedOutput(overrides: Record<string, unknown> = {}): string {
  return `${WORKER_BLOCKED_RESULT_MARKER} ${JSON.stringify({
    status: "BLOCKED",
    reason: "NEEDS_ADVISOR",
    hypothesis: "The parser ownership is unclear",
    attempted_steps: ["Read the implementation", "Ran the focused test"],
    failing_evidence: "expected accepted, received rejected",
    relevant_files: ["src/parser.ts", "test/parser.test.ts"],
    decision_needed: "Choose the authoritative parser",
    ...overrides,
  })}`;
}

describe("createOrchestratedTaskHandler", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("allows orchestrated_task jobs in the database schema", () => {
    const job = db.createWorkJob({
      task_type: "orchestrated_task",
      idempotency_key: "orch:schema:1",
    });

    expect(job.task_type).toBe("orchestrated_task");
  });

  it("plans first and continues to executing with checkpointed phase data", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({
      ...stubs,
      commands: { codex: "codex", claude: "claude", antigravity: "agy" },
    })(
      { work_item_id: item.id, repository_path: "/tmp/repo", preferred_cli: "codex" },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    );

    expect(result.status).toBe("continue");
    expect(result.phase).toBe("executing");
    expect(result.phaseData).toMatchObject({
      workItemId: item.id,
      repoPath: "/tmp/repo",
      branchName: `agent/work-${item.id}`,
      preferredCli: "codex",
    });
    expect(stubs.runCli.mock.calls[0][0]).toBe("codex");
    expect(stubs.runCli.mock.calls[0][1].at(-1)).toMatch(/Do not edit files/i);
  });

  it("folds an advisor plan checkpoint into phase data when configured", async () => {
    const stubs = makeStubs();
    const advisorCheckpoint = vi.fn().mockResolvedValue("Advisor: narrow the migration and add rollback coverage.");
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({ ...stubs, advisorCheckpoint })(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    );

    expect(advisorCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan", taskKey: `work-item:${item.id}` }));
    expect(result.phaseData).toMatchObject({ advisorPlan: expect.stringContaining("rollback") });
  });

  it("runs a PR-readiness advisor checkpoint after tests pass", async () => {
    const stubs = makeStubs();
    const advisorCheckpoint = vi.fn().mockResolvedValue("Advisor: ready for review.");
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await createOrchestratedTaskHandler({ ...stubs, advisorCheckpoint })(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "verifying", phaseData: {
        workItemId: item.id, repoPath: "/tmp/repo", branchName: `agent/work-${item.id}`, plan: "Plan",
      } },
    );

    expect(advisorCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      mode: "pr_ready", taskKey: `work-item:${item.id}`, testOutput: "Tests passed.",
    }));
  });

  it("holds before execution when the Technical Lead rejects the plan", async () => {
    const stubs = makeStubs();
    const advisorCheckpoint = vi.fn().mockResolvedValue({ approved: false, advice: "Plan is underspecified." });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({ ...stubs, advisorCheckpoint })(
      { work_item_id: item.id, repository_path: "/tmp/repo", role_routing_enabled: true },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    );

    expect(result).toMatchObject({ needsHuman: true });
    expect(result.summary).toMatch(/underspecified/i);
    expect(stubs.runCli).toHaveBeenCalledTimes(1);
  });

  it("allows one final-review repair, then requires fresh verification", async () => {
    const stubs = makeStubs();
    const advisorCheckpoint = vi.fn()
      .mockResolvedValueOnce({ approved: false, advice: "Fix the missing guard." })
      .mockResolvedValueOnce({ approved: true, advice: "Ready." });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const review = await createOrchestratedTaskHandler({ ...stubs, advisorCheckpoint })(
      { work_item_id: item.id, role_routing_enabled: true },
      { db, workerId: "w", phase: "verifying", phaseData: {
        workItemId: item.id, repoPath: "/tmp/repo", branchName: `agent/work-${item.id}`, plan: "Plan",
      } },
    );

    expect(review).toMatchObject({ status: "continue", phase: "review_repair" });
    expect(review.phaseData).toMatchObject({ reviewRepairAttempted: false, reviewRepairPending: true });

    const repaired = await createOrchestratedTaskHandler({ ...stubs, advisorCheckpoint })(
      { work_item_id: item.id, role_routing_enabled: true },
      { db, workerId: "w", phase: "review_repair", phaseData: review.phaseData as object },
    );

    expect(repaired).toMatchObject({ status: "continue", phase: "verifying" });
    expect(stubs.runTests).toHaveBeenCalledTimes(1);
    expect(advisorCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("reconciles a committed repair after review_repair phase re-entry without rerunning the worker", async () => {
    const stubs = makeStubs();
    stubs.runGit.mockImplementation((args: string[]) => {
      if (args[0] === "log") return "repair: Add orchestration\n";
      return "";
    });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "review_repair", phaseData: {
        workItemId: item.id, repoPath: "/tmp/repo", branchName: `agent/work-${item.id}`, plan: "Plan",
        reviewRepairAttempted: false, reviewRepairPending: true, advisorPrReady: "Fix the guard.",
      } },
    );

    expect(result).toMatchObject({ status: "continue", phase: "verifying" });
    expect(result.phaseData).toMatchObject({ reviewRepairAttempted: true, reviewRepairPending: false });
    expect(stubs.runCli).not.toHaveBeenCalled();
    expect(stubs.runGit).toHaveBeenCalledWith(["log", "-1", "--format=%s"], "/tmp/repo");
  });

  it("holds instead of retrying when a repair was attempted but cannot be reconciled", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "review_repair", phaseData: {
        workItemId: item.id, repoPath: "/tmp/repo", branchName: `agent/work-${item.id}`, plan: "Plan",
        reviewRepairAttempted: true, reviewRepairPending: true, advisorPrReady: "Fix the guard.",
      } },
    );

    expect(result).toMatchObject({ needsHuman: true });
    expect(stubs.runCli).not.toHaveBeenCalled();
  });

  it("fails closed when a job requires an unavailable advisor", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Sensitive migration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo", advisor_required: true },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    )).rejects.toThrow(/advisor required but disabled/i);
  });

  it("checkpoints a retry recommendation when the executor returns NEEDS_ADVISOR", async () => {
    const stubs = makeStubs();
    stubs.runCli.mockResolvedValue(blockedOutput());
    const advisorDebugCheckpoint = vi.fn().mockResolvedValue({
      verdict: "retry",
      advice: "Use the canonical parser in src/parser.ts and preserve the compatibility wrapper.",
      evidenceIds: ["ev_0123456789abcdef"],
      verificationSteps: ["Run parser.test.ts"],
      confidence: "medium",
    });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Fix parser ownership", body: "Keep compatibility behavior", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({ ...stubs, advisorDebugCheckpoint })(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "executing", phaseData: {
        workItemId: item.id, repoPath: "/tmp/repo", branchName: `agent/work-${item.id}`, plan: "Use one parser",
      } },
    );

    expect(advisorDebugCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      taskKey: `work-item:${item.id}`,
      repoPath: "/tmp/repo",
      acceptanceCriteria: expect.stringContaining("Keep compatibility behavior"),
      blocked: expect.objectContaining({ reason: "NEEDS_ADVISOR" }),
    }));
    expect(result).toMatchObject({ status: "continue", phase: "executing_retry" });
    expect(result.phaseData).toMatchObject({
      debugAttempted: true,
      advisorDebug: { verdict: "retry" },
      blockedResult: { reason: "NEEDS_ADVISOR" },
    });
    expect(stubs.runGit).not.toHaveBeenCalledWith(["add", "-A"], expect.anything());
  });

  it("resumes the checkpointed retry once and commits successful changes", async () => {
    const stubs = makeStubs();
    stubs.runCli.mockResolvedValue("Slice completed after applying the bounded recommendation.");
    const advisorDebugCheckpoint = vi.fn();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Fix parser ownership", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({ ...stubs, advisorDebugCheckpoint })(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "executing_retry", phaseData: {
        workItemId: item.id,
        repoPath: "/tmp/repo",
        branchName: `agent/work-${item.id}`,
        plan: "Use one parser",
        debugAttempted: true,
        blockedResult: {
          status: "BLOCKED", reason: "NEEDS_ADVISOR", hypothesis: "ownership",
          attemptedSteps: ["read"], failingEvidence: "failure", relevantFiles: ["src/parser.ts"], decisionNeeded: "owner",
        },
        advisorDebug: {
          verdict: "retry", advice: "Use canonical parser", evidenceIds: ["ev_0123456789abcdef"],
          verificationSteps: ["Run parser test"], confidence: "medium",
        },
      } },
    );

    expect(result).toMatchObject({ status: "continue", phase: "verifying" });
    expect(stubs.runCli.mock.calls[0][1].at(-1)).toMatch(/only permitted retry/i);
    expect(advisorDebugCheckpoint).not.toHaveBeenCalled();
    expect(stubs.runGit.mock.calls.some(([args]: [string[]]) => args[0] === "commit")).toBe(true);
  });

  it("ends in bounded human-needed state when the retry remains blocked", async () => {
    const stubs = makeStubs();
    stubs.runCli.mockResolvedValue(blockedOutput({ hypothesis: "Still blocked after retry" }));
    const advisorDebugCheckpoint = vi.fn();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Fix parser ownership", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({ ...stubs, advisorDebugCheckpoint })(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "executing_retry", phaseData: {
        workItemId: item.id,
        repoPath: "/tmp/repo",
        branchName: `agent/work-${item.id}`,
        plan: "Use one parser",
        debugAttempted: true,
        blockedResult: {
          status: "BLOCKED", reason: "NEEDS_ADVISOR", hypothesis: "ownership",
          attemptedSteps: ["read"], failingEvidence: "failure", relevantFiles: ["src/parser.ts"], decisionNeeded: "owner",
        },
        advisorDebug: {
          verdict: "retry", advice: "Use canonical parser", evidenceIds: [], verificationSteps: [], confidence: "low",
        },
      } },
    );

    expect(result).toMatchObject({ needsHuman: true });
    expect(result.summary).toMatch(/needs human attention/i);
    expect(advisorDebugCheckpoint).not.toHaveBeenCalled();
    expect(stubs.runGit.mock.calls.some(([args]: [string[]]) => args[0] === "commit")).toBe(false);
  });

  it("does not retry when the advisor requires human input", async () => {
    const stubs = makeStubs();
    stubs.runCli.mockResolvedValue(blockedOutput());
    const advisorDebugCheckpoint = vi.fn().mockResolvedValue({
      verdict: "needs_human",
      advice: "The acceptance criteria conflict and require an owner decision.",
      evidenceIds: [],
      verificationSteps: [],
      confidence: "high",
    });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Resolve conflicting contract", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({ ...stubs, advisorDebugCheckpoint })(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "executing", phaseData: {
        workItemId: item.id, repoPath: "/tmp/repo", branchName: `agent/work-${item.id}`, plan: "Inspect contract",
      } },
    );

    expect(result).toMatchObject({ needsHuman: true, advisorDebug: { verdict: "needs_human" } });
    expect(stubs.runCli).toHaveBeenCalledTimes(1);
  });

  it("executes from the stored plan, commits changes, then continues to verifying", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      {
        db, workerId: "w", phase: "executing",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
          plan: "1. Edit files",
          preferredCli: "claude",
        },
      },
    );

    expect(result.status).toBe("continue");
    expect(result.phase).toBe("verifying");
    expect(stubs.runCli.mock.calls[0][0]).toBe("claude");
    expect(stubs.runGit.mock.calls.some(([args]: [string[]]) => args[0] === "commit")).toBe(true);
    expect(db.getWorkItem(item.id)!.status).toBe("in_progress");
  });

  it("rejects antigravity as preferred_cli for code-writing phases", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo", preferred_cli: "antigravity" },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    )).rejects.toThrow(/not allowed.*orchestrated_task/i);
  });

  it("fails executing when no files are staged", async () => {
    const stubs = makeStubs();
    stubs.runGit.mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) return "";
      return "";
    });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      {
        db, workerId: "w", phase: "executing",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
          plan: "1. Edit files",
        },
      },
    )).rejects.toThrow(/staged no changes/i);
  });

  it("verifies and queues pr_lifecycle with verification output", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id, notify_chat_id: 123 },
      {
        db, workerId: "w", phase: "verifying",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
          plan: "1. Edit files",
        },
      },
    );

    expect(result.summary).toContain("Orchestrated task complete");
    const jobs = db.listWorkJobs().filter(j => j.task_type === "pr_lifecycle");
    expect(jobs).toHaveLength(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input).toMatchObject({
      work_item_id: item.id,
      branch_name: `agent/work-${item.id}`,
      repository: "owner/repo",
      repository_path: "/tmp/repo",
      notify_chat_id: 123,
      verify_output: "Tests passed.",
    });
  });

  it("does not queue pr_lifecycle when verification fails", async () => {
    const stubs = makeStubs();
    stubs.runTests.mockResolvedValue({ ok: false, output: "1 failing" });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      {
        db, workerId: "w", phase: "verifying",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
        },
      },
    )).rejects.toThrow(/verification failed/i);

    expect(db.listWorkJobs().filter(j => j.task_type === "pr_lifecycle")).toHaveLength(0);
  });
});
