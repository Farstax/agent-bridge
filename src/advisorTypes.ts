import type { ProviderId } from "./providers/types.js";

export type AdvisorPolicyMode = "manual" | "suggest" | "auto";
export type AdvisorRequestMode = "plan" | "review" | "debug" | "risk" | "decision" | "pr_ready";
export type AdvisorOrigin = "manual" | "suggest" | "auto";
export type AdvisorConfidence = "low" | "medium" | "high";
export type AdvisorDebugVerdict = "retry" | "needs_human" | "insufficient_evidence";
export type AdvisorCheckpointDecision = "approve" | "reject";

export interface AdvisorTarget { provider: ProviderId; model: string }
export interface AdvisorConfig {
  enabled: boolean; mode: AdvisorPolicyMode; chain: AdvisorTarget[];
  maxCallsPerTurn: number; maxCallsPerTask: number; timeoutMs: number; contextMaxChars: number;
}
export interface AdvisorEvidenceInput {
  diffSummary?: string;
  testOutput?: string;
  constraints?: string[];
  references?: string[];
  acceptanceCriteria?: string;
  plan?: string;
  attemptSummary?: string;
}
export interface AdvisorRequest {
  requestId: string; scopeKey: string; turnKey?: string; taskKey?: string;
  origin: AdvisorOrigin; approved?: boolean; mode: AdvisorRequestMode; task: string;
  activeProvider: string; activeModel: string | null;
  evidence?: AdvisorEvidenceInput;
}
export interface AdvisorEvidenceBasis {
  claim: string;
  evidenceIds: string[];
}
export interface AdvisorResult {
  adviceMd: string; risks: string[]; suggestedNextSteps: string[]; confidence: AdvisorConfidence;
  decision?: AdvisorCheckpointDecision;
  provider: ProviderId; model: string; requestId: string;
  verdict?: AdvisorDebugVerdict;
  evidenceIds?: string[];
  evidenceBasis?: AdvisorEvidenceBasis[];
  assumptions?: string[];
  unresolvedConflicts?: string[];
  verificationSteps?: string[];
}
