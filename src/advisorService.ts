/** Compatibility adapter for the legacy manual engine command. New provider-side use goes through the native advisor Skill. */
import { randomUUID } from "node:crypto";
import { executeAdvisorRequest } from "./advisor.js";
import type { AdvisorConfig, AdvisorOrigin, AdvisorRequestMode, AdvisorResult } from "./advisorTypes.js";
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
}

export class AdvisorService {
  readonly executionProfile = "tool_free" as const;
  constructor(private readonly deps: {
    db: BridgeDb;
    config: AdvisorConfig;
    bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
    runCli: RunCli;
  }) {}
  get config(): AdvisorConfig { return this.deps.config; }
  requestTrusted(request: TrustedAdvisorRequest): Promise<AdvisorResult> {
    return executeAdvisorRequest({
      ...this.deps,
      cwd: request.cwd,
      request: {
        requestId: randomUUID(),
        scopeKey: request.scopeKey,
        turnKey: request.turnKey,
        taskKey: request.taskKey,
        origin: "manual",
        mode: request.mode,
        task: request.task,
        activeProvider: request.activeProvider,
        activeModel: request.activeModel,
      },
    });
  }
}
