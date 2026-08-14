# 06 — Interface Specifications (historical sections retained)

> Worker job and approval interfaces below are historical. They are not live
> runtime contracts.

Design-only. No implementation in this PR.

## ProviderAdapter (Epic 2)

```ts
export interface ProviderCapabilities {
  toolFree: boolean;          // verified support for invocation toolMode: "none"
  streaming: boolean;        // emits incremental output usable as text.delta
  resume: boolean;           // supports session continuation
  interrupt: boolean;        // supports safe mid-run abort with partial result
  effortLevels: EffortLevel[]; // subset supported natively
  attachments: boolean;
  models: string[];          // preference-ordered, env-overridable
}

export interface InvocationRequest {
  prompt: string;
  model: string | null;
  sessionId: string | null;
  effort: EffortLevel;
  cwd: string;
  outputDir: string;
  soulContext: string | null;
  attachments: Attachment[];
  executionMode: "safe" | "trusted";
}

export interface ProviderAdapter {
  readonly kind: string;                      // registry key; BotKind derives from this
  readonly capabilities: ProviderCapabilities;
  readonly timeouts: { cliTimeoutMs: number; cliIdleTimeoutMs: number };
  buildInvocation(req: InvocationRequest): { command: string; args: string[]; env?: Record<string,string> };
  parseResult(stdout: string, stderr: string): CliResult;    // { text, sessionId }
  resolveSession(ctx: { cwd: string; startedAtMs: number }): Promise<string | null>; // post-run, for CLIs without stdout session ids
  classifyError(err: Error, exitCode: number | null): ErrorClass;
  effortArgs(level: EffortLevel, args: string[]): string[];
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;  // binary present + auth valid
}

export type ErrorClass =
  | { kind: "capacity"; retryAfterMs?: number }   // model/plan exhaustion → fallback
  | { kind: "model_unavailable" }                 // model missing → next model
  | { kind: "auth" }                              // never fallback; alert
  | { kind: "transient" }                         // retry same target
  | { kind: "fatal"; reason: string };            // surface to user
```

`ProviderRegistry = Map<string, ProviderAdapter>`; entry points and engine consume the registry; unions/type guards derived from `registry.keys()`.

## Workflow Engine (Epic 5)

```ts
export interface WorkflowStep {
  name: string;                    // "plan" | "implement" | "test" | "review" | "repair" | ...
  skill?: string;                  // named skill pack reference (skills.ts)
  executor: string;                // registered step executor id (wraps current handlers)
  gate?: "plan_approval" | "merge_approval" | "ci_green" | "review_approved";
  onFailure: { retry: number; then: "repair" | "halt" | "skip" };
  timeoutMs?: number;
}

export interface WorkflowDefinition {
  name: "feature" | "bug" | "review" | "refactor" | "documentation" | "security" | "release" | "dependency_upgrade" | "ci_repair";
  steps: WorkflowStep[];
  repairPolicy: { maxRepairs: number; repairWorkflow?: string };
  provider: { preferredCli?: string; effort: EffortLevel };   // merges with workerCliPolicy.ts
}
```

Engine contract: interprets steps sequentially, emits lifecycle events per step, persists step cursor in `work_jobs.input_json` (resumable), respects gates by pausing until an Approval event.

## Event Model (Epic 6) — extends `src/events/types.ts`

```
JobCreated{jobId, workItemId, taskType, workflow?}     JobStarted{jobId, attempt}
ProviderSelected{jobId|runId, kind, model, reason}     ToolCalled{runId, tool, summary}
CommitCreated{jobId, sha, branch}                      PRCreated{jobId, prNumber, url}
ReviewReceived{prNumber, author, verdict, body}        CIStarted{prNumber, checkId}
CIFailed{prNumber, checkId, summary}                   RepairStarted{jobId, cause: "ci"|"review"|"test"}
RepairFinished{jobId, outcome}                         ApprovalRequested{gate, ref}
Merged{prNumber, sha}                                  Completed{jobId, outcome}
```
All share the existing `BridgeEventBase` (id, runId?, timestamp, chatId?) plus `jobId?`. Append via EventStore; reducer derives `work_jobs.status` and PR state; subscribers: telegramAdapter (progress messages), metrics (Epic 10).

## Memory (Epic 7)

```ts
type MemoryKind = "workspace" | "repository" | "conversation" | "provider" | "decision" | "review" | "failure";
interface MemoryRecord { id; kind: MemoryKind; scopeRef: string; text: string; confidence: number; provenance; createdAt; }
// scopeRef examples: repo full name, chatKey, provider kind, jobId
interface MemoryRepositoryAPI {
  store(rec: Omit<MemoryRecord,"id"|"createdAt">): void;
  recall(kind: MemoryKind, scopeRef: string, limit?: number): MemoryRecord[];
  recallForPrompt(scope: { repo?: string; chatKey?: string; provider?: string }): MemoryRecord[]; // ranked, budgeted
}
```

## OSS ↔ Platform boundary (Epic 1, ADR-006)

```
POST /bootstrap   {workspaceId, botTokens{surface→token}, allowedUserIds, repos[]}  → {ok, version}
GET  /heartbeat   → {version, services[{name, active, lastError?}], queueDepth, lastEventAt}
```
OSS implements both; platform consumes. No platform concepts (billing, auth identities, provisioning) enter OSS types.

## GitHub sync (Epic 9, ADR-005)

```
task_type: "github_sync"  (hourly + on-demand /import)
import: open issues (label-filtered) → work_items{source:"github", external_ref}
export: work_item status → issue labels (ab:planning, ab:in-progress, ab:pr-open); merge → close with comment
conflict rule: GitHub wins content; bridge wins execution state; deletions never propagated automatically.
```
