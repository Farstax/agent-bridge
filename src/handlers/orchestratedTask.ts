/**
 * PURPOSE: Resumable multi-phase implementation job handler.
 * Plans, executes, verifies, then queues PR lifecycle work behind the existing
 * human merge gate.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts, src/handlers/prLifecycle.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { requestConfiguredWorkerAdvisorDebug } from "../advisorBroker.js";
import { redactAdvisorEvidenceText } from "../advisorEvidenceRedaction.js";
import { isCodeCliAllowed } from "../workerCliPolicy.js";
import { createWorkerPromptFileReader } from "../workerPromptFileReader.js";
import { loadWorkerPrompt } from "../workerPrompts.js";
import {
  formatWorkerBlockedResult,
  parseWorkerBlockedResult,
  type WorkerBlockedResult,
} from "../workerBlockedResult.js";
import type { AdvisorDebugVerdict, AdvisorEvidenceBasis } from "../advisorTypes.js";

type CliKind = "codex" | "claude" | "antigravity";
type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunGit = (args: string[], cwd: string) => string | Promise<string>;
type RunTests = (cwd: string) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>;

export interface AdvisorDebugCheckpointResult {
  verdict: AdvisorDebugVerdict;
  advice: string;
  evidenceIds: string[];
  verificationSteps: string[];
  confidence: "low" | "medium" | "high";
  evidenceBasis?: AdvisorEvidenceBasis[];
  assumptions?: string[];
  unresolvedConflicts?: string[];
}

interface TechnicalLeadCheckpointResult {
  approved: boolean;
  advice: string;
}

interface OrchestratedTaskDeps {
  runCli: RunCli;
  runGit: RunGit;
  runTests: RunTests;
  command?: string;
  commands?: Partial<Record<CliKind, string>>;
  cliExtraArgs?: string[];
  prepareWorkspace?: (repository: string, workItemId: number, opts?: { reuseExisting?: boolean }) => Promise<string>;
  cleanupWorkspace?: (dir: string) => void;
  advisorCheckpoint?: (input: {
    mode: "plan" | "pr_ready";
    taskKey: string;
    task: string;
    repoPath: string;
    diffSummary?: string;
    testOutput?: string;
  }) => Promise<string | TechnicalLeadCheckpointResult>;
  advisorRequired?: boolean;
  advisorDebugCheckpoint?: (input: {
    taskKey: string;
    task: string;
    repoPath: string;
    acceptanceCriteria: string;
    plan: string;
    blocked: WorkerBlockedResult;
  }) => Promise<AdvisorDebugCheckpointResult>;
}

const promptReader = createWorkerPromptFileReader();

function notifyFields(input: JobHandlerInput): Record<string, number> {
  return {
    ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
    ...(typeof input.notify_thread_id === "number" ? { notify_thread_id: input.notify_thread_id } : {}),
  };
}

interface OrchestratedPhaseData {
  workItemId?: number;
  repoPath?: string;
  workspaceDir?: string | null;
  branchName?: string;
  plan?: string;
  preferredCli?: CliKind;
  verifyOutput?: string;
  advisorPlan?: string;
  reviewRepairAttempted?: boolean;
  advisorPrReady?: string;
  advisorDebug?: AdvisorDebugCheckpointResult;
  blockedResult?: WorkerBlockedResult;
  debugAttempted?: boolean;
}

function preferredCli(input: JobHandlerInput): CliKind | null {
  const value = input.preferred_cli;
  return value === "codex" || value === "claude" || value === "antigravity" ? value : null;
}

function commandFor(deps: OrchestratedTaskDeps, cli: CliKind | null): string {
  if (cli && deps.commands?.[cli]) return deps.commands[cli]!;
  if (cli === "codex") return process.env.CODEX_COMMAND || "codex";
  if (cli === "antigravity") return process.env.ANTIGRAVITY_COMMAND || "agy";
  if (cli === "claude") return process.env.CLAUDE_COMMAND || "claude";
  return deps.command || "claude";
}

async function buildPlanPrompt( item: { repository: string | null; title: string; body: string | null }): Promise<string> {
  return loadWorkerPrompt(
    "orchestrated_task:plan",
    {
      repository: item.repository ?? "(unknown)",
      title: item.title,
      body: item.body ?? "",
    },
    promptReader,
  );
}

async function buildExecutePrompt( title: string, plan: string, advisorPlan?: string): Promise<string> {
  return loadWorkerPrompt(
    "orchestrated_task:execute",
    {
      title,
      plan_text: plan,
      execution_contract: advisorPlan ? `Frontier advisor review:\n${advisorPlan}` : "",
    },
    promptReader,
  );
}

function normalizeCheckpoint(value: string | TechnicalLeadCheckpointResult): TechnicalLeadCheckpointResult {
  if (typeof value === "string") return { approved: true, advice: value };
  return { approved: value.approved === true, advice: value.advice.trim() };
}

function evidenceBasisText(debug: AdvisorDebugCheckpointResult): string[] {
  return (debug.evidenceBasis ?? []).slice(0, 24).map((basis) => {
    const claim = basis.claim.slice(0, 1_200);
    const ids = basis.evidenceIds.slice(0, 12).join(", ");
    return `- ${claim} [${ids}]`;
  });
}

async function buildDebugRetryPrompt(
  ctx: JobHandlerContext,
  title: string,
  plan: string,
  advisorPlan: string | undefined,
  blocked: WorkerBlockedResult,
  debug: AdvisorDebugCheckpointResult,
): Promise<string> {
  const base = await buildExecutePrompt(title, plan, advisorPlan);
  const basis = evidenceBasisText(debug);
  return [
    base,
    "",
    "---",
    "",
    "# One bounded debug retry",
    "",
    "The previous executor attempt returned BLOCKED / NEEDS_ADVISOR. This is the only permitted retry.",
    `Previous blocked result:\n${formatWorkerBlockedResult(blocked)}`,
    `Advisor recommendation (${debug.confidence} confidence):\n${debug.advice}`,
    ...(basis.length ? [`Evidence basis:\n${basis.join("\n")}`] : []),
    ...(debug.assumptions?.length ? [`Advisor assumptions:\n${debug.assumptions.slice(0, 12).map((item) => `- ${item}`).join("\n")}`] : []),
    ...(debug.unresolvedConflicts?.length ? [`Unresolved conflicts:\n${debug.unresolvedConflicts.slice(0, 12).map((item) => `- ${item}`).join("\n")}`] : []),
    ...(debug.evidenceIds.length ? [`Evidence identifiers: ${debug.evidenceIds.join(", ")}`] : []),
    ...(debug.verificationSteps.length ? [`Required verification:\n${debug.verificationSteps.map((step) => `- ${step}`).join("\n")}`] : []),
    "Apply only the changes justified by the plan and recommendation. Do not invoke the advisor directly.",
    "If still blocked, return one AGENT_BRIDGE_BLOCKED_RESULT marker. A second advisor loop is forbidden.",
  ].join("\n\n");
}

function blockedSummary(workItemId: number, blocked: WorkerBlockedResult, advisor?: AdvisorDebugCheckpointResult): JobHandlerResult {
  return {
    summary: [
      `Orchestrated task for work item #${workItemId} needs human attention.`,
      formatWorkerBlockedResult(blocked),
      ...(advisor ? [`Advisor verdict: ${advisor.verdict} (${advisor.confidence} confidence)`, advisor.advice] : []),
    ].join("\n\n"),
    needsHuman: true,
    blockedResult: blocked,
    advisorDebug: advisor,
  };
}

function retryFailureSummary(
  workItemId: number,
  blocked: WorkerBlockedResult,
  advisor: AdvisorDebugCheckpointResult,
  caught: unknown,
): JobHandlerResult {
  const message = redactAdvisorEvidenceText(caught instanceof Error ? caught.message : String(caught)).slice(0, 2_000);
  return {
    summary: [
      `Orchestrated task for work item #${workItemId} failed during its only permitted debug retry and needs human attention.`,
      `Retry failure: ${message}`,
      formatWorkerBlockedResult(blocked),
      `Advisor verdict: ${advisor.verdict} (${advisor.confidence} confidence)`,
      advisor.advice,
    ].join("\n\n"),
    needsHuman: true,
    blockedResult: blocked,
    advisorDebug: advisor,
    retryFailure: message,
  };
}

export function createOrchestratedTaskHandler(deps: OrchestratedTaskDeps): JobHandler {
  const {
    runCli,
    runGit,
    runTests,
    cliExtraArgs = [],
    prepareWorkspace,
    cleanupWorkspace,
    advisorCheckpoint,
    advisorDebugCheckpoint,
  } = deps;

  const consultAdvisor = async (
    input: JobHandlerInput,
    checkpoint: Parameters<NonNullable<OrchestratedTaskDeps["advisorCheckpoint"]>>[0],
  ): Promise<TechnicalLeadCheckpointResult | undefined> => {
    if (!advisorCheckpoint) {
      if (deps.advisorRequired || input.advisor_required === true) throw new Error("Advisor required but disabled or unavailable");
      return undefined;
    }
    try {
      return normalizeCheckpoint(await advisorCheckpoint(checkpoint));
    } catch (error) {
      if (deps.advisorRequired || input.advisor_required === true) throw error;
      console.warn(`[advisor] optional worker checkpoint failed mode=${checkpoint.mode}:`, error);
      return undefined;
    }
  };

  const consultDebugAdvisor = async (
    input: JobHandlerInput,
    checkpoint: Parameters<NonNullable<OrchestratedTaskDeps["advisorDebugCheckpoint"]>>[0],
    db: JobHandlerContext["db"],
    activeProvider: string,
  ): Promise<AdvisorDebugCheckpointResult | undefined> => {
    try {
      if (advisorDebugCheckpoint) return await advisorDebugCheckpoint(checkpoint);
      const result = await requestConfiguredWorkerAdvisorDebug({
        db,
        ...checkpoint,
        activeProvider,
        runGit,
        audit: (event) => console.info("[advisor:evidence]", JSON.stringify(event)),
      });
      return {
        verdict: result.verdict ?? "insufficient_evidence",
        advice: [
          result.adviceMd,
          ...result.risks.map((risk) => `Risk: ${risk}`),
          ...result.suggestedNextSteps.map((step) => `Next: ${step}`),
        ].join("\n"),
        evidenceIds: result.evidenceIds ?? [],
        verificationSteps: result.verificationSteps ?? [],
        confidence: result.confidence,
        evidenceBasis: result.evidenceBasis ?? [],
        assumptions: result.assumptions ?? [],
        unresolvedConflicts: result.unresolvedConflicts ?? [],
      };
    } catch (error) {
      if (input.advisor_required === true) throw error;
      console.warn("[advisor] optional worker debug checkpoint failed:", error);
      return undefined;
    }
  };

  return async function orchestratedTaskHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const phaseData = ctx.phaseData as OrchestratedPhaseData;
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : phaseData.workItemId;
    if (typeof workItemId !== "number") throw new Error("input.work_item_id is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    const selectedCli = preferredCli(input) ?? phaseData.preferredCli ?? null;
    if (selectedCli && !isCodeCliAllowed(selectedCli)) {
      throw new Error(`CLI ${selectedCli} is not allowed for orchestrated_task code-writing phases`);
    }
    const command = commandFor(deps, selectedCli);
    const branchName = phaseData.branchName ?? `agent/work-${workItemId}`;

    const commitExecution = async (repoPath: string, currentPhaseData: OrchestratedPhaseData): Promise<JobHandlerResult> => {
      await runGit(["add", "-A"], repoPath);
      const staged = String(await runGit(["diff", "--cached", "--name-only"], repoPath)).trim();
      if (!staged) throw new Error("Execution phase staged no changes");
      await runGit(["commit", "-m", `implement: ${item.title}`], repoPath);
      ctx.db.updateWorkItemStatus(workItemId, "in_progress");
      return {
        status: "continue",
        phase: "verifying",
        phaseData: currentPhaseData,
        summary: `Implementation committed for work item #${workItemId}; verifying next.`,
      };
    };

    if (ctx.phase === "initial") {
      let repoPath: string;
      let workspaceDir: string | null = null;
      if (typeof input.repository_path === "string") {
        repoPath = input.repository_path;
      } else if (item.repository && prepareWorkspace) {
        workspaceDir = await prepareWorkspace(item.repository, workItemId);
        repoPath = workspaceDir;
      } else {
        throw new Error(
          `Work item ${workItemId} has no repository_path and no resolvable repository — refusing to run in the worker's own directory`,
        );
      }

      const status = await runGit(["status", "--porcelain"], repoPath);
      if (String(status).trim()) {
        throw new Error(`Repository has uncommitted changes (dirty working tree):\n${status}`);
      }
      await runGit(["checkout", "-b", branchName], repoPath);

      const planPrompt = await buildPlanPrompt( item);
      const plan = await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, planPrompt], repoPath);
      const advisorPlan = await consultAdvisor(input, {
        mode: "plan",
        taskKey: `work-item:${workItemId}`,
        task: `Review the implementation plan for: ${item.title}`,
        repoPath,
        diffSummary: plan,
      });
      if (advisorPlan && !advisorPlan.approved) {
        return {
          summary: `Technical Lead rejected the implementation plan for work item #${workItemId}; human input is required.\n\n${advisorPlan.advice}`,
          needsHuman: true,
          advisorPlan,
        };
      }
      return {
        status: "continue",
        phase: "executing",
        phaseData: { workItemId, repoPath, workspaceDir, branchName, plan, advisorPlan: advisorPlan?.advice, preferredCli: selectedCli ?? undefined },
        summary: `Plan complete for work item #${workItemId}; executing next.`,
      };
    }

    if (ctx.phase === "executing") {
      if (!phaseData.repoPath || !phaseData.plan) throw new Error("orchestrated_task missing execution phase data");
      const executePrompt = await buildExecutePrompt(item.title, phaseData.plan, phaseData.advisorPlan);
      const output = await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, executePrompt], phaseData.repoPath);
      const blocked = parseWorkerBlockedResult(output);
      if (!blocked) return commitExecution(phaseData.repoPath, phaseData);

      const advisorDebug = await consultDebugAdvisor(input, {
        taskKey: `work-item:${workItemId}`,
        task: `Diagnose the blocked implementation attempt for: ${item.title}`,
        repoPath: phaseData.repoPath,
        acceptanceCriteria: [item.title, item.body ?? ""].filter(Boolean).join("\n\n"),
        plan: phaseData.plan,
        blocked,
      }, ctx.db, selectedCli ?? "codex");
      if (!advisorDebug || advisorDebug.verdict !== "retry") return blockedSummary(workItemId, blocked, advisorDebug);

       return {
        status: "continue",
        phase: "executing_retry",
        phaseData: {
          ...phaseData,
          advisorDebug,
          blockedResult: blocked,
          debugAttempted: true,
        },
        summary: `Advisor debug review complete for work item #${workItemId}; one bounded executor retry queued.`,
      };
    }

    if (ctx.phase === "executing_retry") {
      if (!phaseData.repoPath || !phaseData.plan || !phaseData.advisorDebug || !phaseData.blockedResult || !phaseData.debugAttempted) {
        throw new Error("orchestrated_task missing debug retry phase data");
      }
      try {
        const retryPrompt = await buildDebugRetryPrompt(
          ctx,
          item.title,
          phaseData.plan,
          phaseData.advisorPlan,
          phaseData.blockedResult,
          phaseData.advisorDebug,
        );
        const retryOutput = await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, retryPrompt], phaseData.repoPath);
        const repeatedBlocked = parseWorkerBlockedResult(retryOutput);
        if (repeatedBlocked) return blockedSummary(workItemId, repeatedBlocked, phaseData.advisorDebug);
        return await commitExecution(phaseData.repoPath, phaseData);
      } catch (error) {
        return retryFailureSummary(workItemId, phaseData.blockedResult, phaseData.advisorDebug, error);
      }
    }

    if (ctx.phase === "review_repair") {
      if (!phaseData.repoPath || !phaseData.plan || !phaseData.branchName) {
        throw new Error("orchestrated_task review repair is missing state or has already been attempted");
      }
      const repairPrompt = [
        await buildExecutePrompt(item.title, phaseData.plan, phaseData.advisorPlan),
        "",
        "A Technical Lead rejected the verified result. Apply exactly one bounded repair for this finding, then stop.",
        phaseData.advisorPrReady ? `Technical Lead finding:\n${phaseData.advisorPrReady}` : "",
        "Do not broaden scope, invoke an advisor, or perform GitHub, deployment, service, or merge actions.",
      ].filter(Boolean).join("\n\n");
      await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, repairPrompt], phaseData.repoPath);
      await runGit(["add", "-A"], phaseData.repoPath);
      const staged = String(await runGit(["diff", "--cached", "--name-only"], phaseData.repoPath)).trim();
      if (!staged) throw new Error("Technical Lead repair staged no changes");
      await runGit(["commit", "-m", `repair: ${item.title}`], phaseData.repoPath);
      ctx.db.updateWorkItemStatus(workItemId, "in_progress");
      return {
        status: "continue",
        phase: "verifying",
        phaseData: { ...phaseData, reviewRepairAttempted: true, advisorPrReady: undefined },
        summary: `Technical Lead repair committed for work item #${workItemId}; verifying again.`,
      };
    }

    if (ctx.phase === "verifying") {
      if (!phaseData.repoPath || !phaseData.branchName) throw new Error("orchestrated_task missing verification phase data");
      const verify = await runTests(phaseData.repoPath);
      if (!verify.ok) throw new Error(`Verification failed:\n${verify.output}`);
      const advisorPrReady = await consultAdvisor(input, {
        mode: "pr_ready",
        taskKey: `work-item:${workItemId}`,
        task: `Review PR readiness for: ${item.title}`,
        repoPath: phaseData.repoPath,
        testOutput: verify.output,
        diffSummary: phaseData.plan,
      });

      if (advisorPrReady && !advisorPrReady.approved) {
        if (phaseData.reviewRepairAttempted) {
          return {
            summary: `Technical Lead rejected the repaired result for work item #${workItemId}; human input is required.\n\n${advisorPrReady.advice}`,
            needsHuman: true,
            advisorPrReady,
            verifyOutput: verify.output,
          };
        }
        return {
          status: "continue",
          phase: "review_repair",
          phaseData: { ...phaseData, reviewRepairAttempted: true, advisorPrReady: advisorPrReady.advice, verifyOutput: verify.output },
          summary: `Technical Lead rejected the verified result for work item #${workItemId}; one bounded repair queued.`,
        };
      }

      if (item.repository) {
        ctx.db.createWorkJob({
          task_type: "pr_lifecycle",
          idempotency_key: `pr_lifecycle:${workItemId}`,
          work_item_id: workItemId,
          input_json: {
            work_item_id: workItemId,
            branch_name: phaseData.branchName,
            repository: item.repository,
            repository_path: phaseData.repoPath,
            verify_output: verify.output,
            ...(phaseData.workspaceDir ? { workspace_dir: phaseData.workspaceDir } : {}),
            ...notifyFields(input),
          },
        });
      } else if (phaseData.workspaceDir && cleanupWorkspace) {
        cleanupWorkspace(phaseData.workspaceDir);
      }

      return {
        summary: `Orchestrated task complete for **${phaseData.branchName}**\n\n${verify.output}${advisorPrReady ? `\n\nAdvisor: ${advisorPrReady.advice}` : ""}`,
        branchName: phaseData.branchName,
        verifyOutput: verify.output,
        advisorPrReady,
      };
    }

    throw new Error(`Unknown orchestrated_task phase: ${ctx.phase}`);
  };
}
