/**
 * PURPOSE: Single trusted entry point for every advisor request origin.
 * INPUTS: Bridge-owned config, bots, db, and per-request trusted scope details.
 * OUTPUTS: AdvisorResult produced by the shared mutation-free execution path.
 * NEIGHBORS: src/advisor.ts, src/advisorBroker.ts, src/engine.ts, src/index-worker.ts
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { executeAdvisorInvestigation, executeAdvisorRequest } from "./advisor.js";
import { redactAdvisorEvidenceText } from "./advisorEvidenceRedaction.js";
import { AdvisorEvidenceToolBroker, type AdvisorWorkerEvidence } from "./advisorEvidenceTools.js";
import type { AdvisorExecutionProfile } from "./advisorPolicy.js";
import type { AdvisorConfig, AdvisorOrigin, AdvisorRequest, AdvisorRequestMode, AdvisorResult } from "./advisorTypes.js";
import type { BridgeDb } from "./db.js";
import type { BotConfig, BotKind } from "./types.js";

type RunCli = (command: string, args: string[], cwd: string, options: Record<string, unknown>) => Promise<string>;

export interface TrustedAdvisorRequest {
  origin: AdvisorOrigin;
  scopeKey: string;
  turnKey?: string;
  taskKey?: string;
  mode: AdvisorRequestMode;
  task: string;
  activeProvider: string;
  activeModel: string | null;
  cwd: string;
  approved?: boolean;
  evidence?: AdvisorRequest["evidence"];
  /** Optional caller-supplied read-only broker, including worker-specific evidence. */
  evidenceTools?: AdvisorEvidenceToolBroker;
}

function scrubEvidence(evidence: AdvisorRequest["evidence"]): AdvisorRequest["evidence"] {
  if (!evidence) return undefined;
  return {
    ...(evidence.diffSummary != null ? { diffSummary: redactAdvisorEvidenceText(evidence.diffSummary) } : {}),
    ...(evidence.testOutput != null ? { testOutput: redactAdvisorEvidenceText(evidence.testOutput) } : {}),
    ...(evidence.constraints != null ? { constraints: evidence.constraints.map(redactAdvisorEvidenceText) } : {}),
    ...(evidence.references != null ? { references: evidence.references.map(redactAdvisorEvidenceText) } : {}),
    ...(evidence.acceptanceCriteria != null ? { acceptanceCriteria: redactAdvisorEvidenceText(evidence.acceptanceCriteria) } : {}),
    ...(evidence.plan != null ? { plan: redactAdvisorEvidenceText(evidence.plan) } : {}),
    ...(evidence.attemptSummary != null ? { attemptSummary: redactAdvisorEvidenceText(evidence.attemptSummary) } : {}),
  };
}

function createRepositoryEvidenceTools(
  request: TrustedAdvisorRequest,
  evidence: AdvisorRequest["evidence"],
): AdvisorEvidenceToolBroker | undefined {
  try {
    if (!statSync(request.cwd).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const workerEvidence: AdvisorWorkerEvidence = {
    ...(evidence?.acceptanceCriteria ? { acceptance: evidence.acceptanceCriteria } : {}),
    ...(evidence?.plan ? { plan: evidence.plan } : {}),
    ...(evidence?.testOutput ? { testFailures: evidence.testOutput } : {}),
    ...(evidence?.attemptSummary ? { attemptSummary: evidence.attemptSummary } : {}),
  };
  return new AdvisorEvidenceToolBroker({
    repoPath: request.cwd,
    ...(Object.keys(workerEvidence).length > 0 ? { evidence: workerEvidence } : {}),
  });
}

export class AdvisorService {
  // Provider-native tools stay disabled. Agent Bridge mediates any evidence
  // access through its bounded read-only broker.
  readonly executionProfile: AdvisorExecutionProfile = "tool_free";

  constructor(private readonly deps: {
    db: BridgeDb;
    config: AdvisorConfig;
    bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
    runCli: RunCli;
  }) {}

  get config(): AdvisorConfig { return this.deps.config; }

  requestTrusted(request: TrustedAdvisorRequest): Promise<AdvisorResult> {
    const trustedRequest: AdvisorRequest = {
      requestId: randomUUID(),
      scopeKey: request.scopeKey,
      turnKey: request.turnKey,
      taskKey: request.taskKey,
      origin: request.origin,
      approved: request.approved,
      mode: request.mode,
      task: redactAdvisorEvidenceText(request.task),
      activeProvider: request.activeProvider,
      activeModel: request.activeModel,
      evidence: scrubEvidence(request.evidence),
    };
    const deps = {
      db: this.deps.db,
      config: this.deps.config,
      bots: this.deps.bots,
      runCli: this.deps.runCli,
      cwd: request.cwd,
      executionProfile: this.executionProfile,
      request: trustedRequest,
    };
    const evidenceTools = request.evidenceTools ?? createRepositoryEvidenceTools(request, trustedRequest.evidence);
    return evidenceTools
      ? executeAdvisorInvestigation({ ...deps, evidenceTools })
      : executeAdvisorRequest(deps);
  }
}
