import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BotKind } from "./types.js";
import type { BridgeDb } from "./db.js";
import type { BridgeEngine } from "./engine.js";
import {
  cancelAutonomousGoal,
  createAutonomousGoalIfNoneActive,
  drainAutonomousGoal,
  getAutonomousGoal,
  getAutonomousSupervisorState,
  recordAutonomousSupervisorInput,
  recordAutonomousSupervisorMessageId,
  type AutonomousGoal,
  type AutonomousSupervisorRoute,
  type CycleReconciledEvent,
} from "./autonomousGoalRuntime.js";
import {
  parseAutonomyMaxEpisodesPerDay,
  parseAutonomyRequireEpisodeApproval,
} from "./providerLock.js";
import { interactiveChainKinds, parseCliChain } from "./providers/selection.js";
import { createSurfaceNeutralProviderRouter } from "./surfaceNeutralProviderRouter.js";

const MAX_AUTONOMY_FILE_CHARS = 12_000;
const MAX_POLICY_INSTRUCTION_CHARS = 2_000;
const MAX_SUCCESSOR_INPUT_CHARS = 3_000;
const MAX_SUCCESSOR_INPUT_TOTAL_CHARS = 6_000;
const MAX_SUCCESSOR_INPUTS = 8;
const SUCCESSOR_INPUT_SETTING_PREFIX = "autonomy:successor-input:";
const SUCCESSOR_INTENT_SETTING = "autonomy:successor-intent";
const DAILY_EPISODE_COUNT_SETTING_PREFIX = "autonomy:episodes-per-day:";
const FROZEN_EPISODE_PREFIX = "[Frozen Episode authority]";

interface SuccessorInputRecord {
  idempotencyKey: string;
  text: string;
}

interface SuccessorIntent {
  predecessorGoalId: string;
}

export class AutonomyDailyEpisodeLimitError extends Error {
  constructor(public readonly used: number, public readonly limit: number) {
    super(`autonomy daily Episode limit reached (${used}/${limit} UTC)`);
    this.name = "AutonomyDailyEpisodeLimitError";
  }
}

export interface AutonomyControllerStartInput {
  bot: BotKind;
  maxCycles?: number;
  initialEvidence?: string[];
  policyInstruction?: string;
  supervisorRoute?: AutonomousSupervisorRoute;
}

export interface AutonomyControllerStatus {
  state: "idle" | "running" | "terminal";
  goal?: AutonomousGoal;
}

export interface AutonomyControllerOptions {
  db: BridgeDb;
  autonomyDir: string;
  maxCycles: number;
  requireEpisodeApproval?: boolean;
  maxEpisodesPerDay?: number;
  providerChain?: readonly BotKind[];
  engineForBot: (bot: BotKind) => Pick<BridgeEngine, "executeSurfaceNeutralTurn">;
  deliverSupervisorMessage?: (route: AutonomousSupervisorRoute, text: string) => Promise<number>;
  log?: Pick<Console, "error">;
}

function activeGoals(db: BridgeDb): AutonomousGoal[] {
  const rows = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status = 'active' ORDER BY created_at DESC, goal_id DESC").all() as Array<{ goal_id: string }>;
  return rows.map((row) => getAutonomousGoal(db, row.goal_id));
}

function latestGoal(db: BridgeDb): AutonomousGoal | null {
  const row = db.raw.prepare("SELECT goal_id FROM autonomous_goals ORDER BY created_at DESC, goal_id DESC LIMIT 1").get() as { goal_id: string } | undefined;
  return row ? getAutonomousGoal(db, row.goal_id) : null;
}

function latestTerminalGoal(db: BridgeDb): AutonomousGoal | null {
  const row = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status <> 'active' ORDER BY created_at DESC, goal_id DESC LIMIT 1").get() as { goal_id: string } | undefined;
  return row ? getAutonomousGoal(db, row.goal_id) : null;
}

function successorInputSettingKey(goalId: string): string {
  return `${SUCCESSOR_INPUT_SETTING_PREFIX}${goalId}`;
}

function parseSuccessorInputs(raw: string | null): SuccessorInputRecord[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is SuccessorInputRecord => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<SuccessorInputRecord>;
      return typeof candidate.idempotencyKey === "string"
        && candidate.idempotencyKey.length > 0
        && candidate.idempotencyKey.length <= 512
        && typeof candidate.text === "string"
        && candidate.text.length > 0
        && candidate.text.length <= MAX_SUCCESSOR_INPUT_CHARS;
    }).slice(-MAX_SUCCESSOR_INPUTS);
  } catch {
    return [];
  }
}

function parseSuccessorIntent(raw: string | null): SuccessorIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SuccessorIntent>;
    return typeof value.predecessorGoalId === "string" && value.predecessorGoalId
      ? { predecessorGoalId: value.predecessorGoalId }
      : null;
  } catch {
    return null;
  }
}

export class AutonomyController {
  readonly workDir: string;
  private readonly draining = new Set<string>();
  private readonly requireEpisodeApproval: boolean;
  private readonly maxEpisodesPerDay: number;
  private readonly providerChain: readonly BotKind[];
  private resumingSuccessor = false;

  constructor(private readonly options: AutonomyControllerOptions) {
    if (!isAbsolute(options.autonomyDir)) throw new Error("AGENT_BRIDGE_AUTONOMY_DIR must be absolute");
    if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1) throw new Error("autonomy maxCycles must be a positive integer");
    this.requireEpisodeApproval = options.requireEpisodeApproval
      ?? parseAutonomyRequireEpisodeApproval(process.env.AGENT_BRIDGE_AUTONOMY_REQUIRE_EPISODE_APPROVAL);
    this.maxEpisodesPerDay = options.maxEpisodesPerDay
      ?? parseAutonomyMaxEpisodesPerDay(process.env.AGENT_BRIDGE_AUTONOMY_MAX_EPISODES_PER_DAY);
    const allowed = interactiveChainKinds() as BotKind[];
    this.providerChain = options.providerChain ?? parseCliChain(
      process.env.INTERACTIVE_CLI_CHAIN,
      { allowed, fallback: ["codex", "claude", "antigravity"] },
    );
    this.workDir = join(options.autonomyDir, "work");
    mkdirSync(this.workDir, { recursive: true });
  }

  private frozenPrompt(policyInstruction?: string): string {
    const autonomyPath = join(this.options.autonomyDir, "AUTONOMY.md");
    const authority = readFileSync(autonomyPath, "utf8").trim();
    if (!authority || authority.length > MAX_AUTONOMY_FILE_CHARS) throw new Error("AUTONOMY.md must be non-empty and bounded");
    const policy = policyInstruction?.trim() ?? "";
    if (policy.length > MAX_POLICY_INSTRUCTION_CHARS) throw new Error("autonomy policyInstruction is too long");
    return [
      FROZEN_EPISODE_PREFIX,
      authority,
      ...(policy ? ["", "[Authorized start policy instruction]", policy] : []),
    ].join("\n");
  }

  private utcDay(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private dailyCountSettingKey(): string {
    return `${DAILY_EPISODE_COUNT_SETTING_PREFIX}${this.utcDay()}`;
  }

  private episodesToday(): number {
    const row = this.options.db.raw.prepare(`
      SELECT COUNT(*) AS count FROM autonomous_goals
      WHERE substr(created_at, 1, 10) = ? AND prompt LIKE ?
    `).get(this.utcDay(), `${FROZEN_EPISODE_PREFIX}%`) as { count: number };
    return Number(row.count);
  }

  private createEpisodeWithDailyReservation(input: Parameters<typeof createAutonomousGoalIfNoneActive>[1]): ReturnType<typeof createAutonomousGoalIfNoneActive> {
    return this.options.db.runInTransaction(() => {
      const key = this.dailyCountSettingKey();
      const observed = this.episodesToday();
      const rawReserved = Number(this.options.db.getSetting(key) ?? "0");
      const reserved = Number.isInteger(rawReserved) && rawReserved >= 0 ? rawReserved : 0;
      const used = Math.max(observed, reserved);
      if (used >= this.maxEpisodesPerDay) throw new AutonomyDailyEpisodeLimitError(used, this.maxEpisodesPerDay);

      // Take the SQLite write lock before the active-Episode check/create. The
      // reservation is in the same transaction, so a failed/no-op create rolls
      // back or is restored and can never consume phantom daily allowance.
      this.options.db.setSetting(key, String(used + 1));
      const result = createAutonomousGoalIfNoneActive(this.options.db, input);
      if (!result.created) this.options.db.setSetting(key, String(used));
      return result;
    });
  }

  private recordSuccessorInput(input: { goalId: string; text: string; idempotencyKey: string }): boolean {
    const goal = getAutonomousGoal(this.options.db, input.goalId);
    if (goal.status === "active") return false;
    const text = input.text.trim();
    if (!text || text.length > MAX_SUCCESSOR_INPUT_CHARS) throw new Error("autonomous successor input must be bounded and non-empty");
    if (!input.idempotencyKey || input.idempotencyKey.length > 512) throw new Error("invalid autonomous successor input idempotency key");

    return this.options.db.runInTransaction(() => {
      const key = successorInputSettingKey(input.goalId);
      const current = parseSuccessorInputs(this.options.db.getSetting(key));
      if (current.some((entry) => entry.idempotencyKey === input.idempotencyKey)) return true;
      if (current.length >= MAX_SUCCESSOR_INPUTS) throw new Error("too many autonomous successor inputs");
      if (current.reduce((sum, entry) => sum + entry.text.length, 0) + text.length > MAX_SUCCESSOR_INPUT_TOTAL_CHARS) {
        throw new Error("autonomous successor input total exceeds bound");
      }
      this.options.db.setSetting(key, JSON.stringify([...current, { idempotencyKey: input.idempotencyKey, text }]));
      return true;
    });
  }

  private promoteSuccessorInputs(predecessorGoalId: string, successorGoalId: string): void {
    const key = successorInputSettingKey(predecessorGoalId);
    const inputs = parseSuccessorInputs(this.options.db.getSetting(key));
    if (inputs.length === 0) return;
    for (const input of inputs) {
      const recorded = recordAutonomousSupervisorInput(this.options.db, {
        goalId: successorGoalId,
        text: input.text,
        idempotencyKey: `${successorGoalId}:successor:${input.idempotencyKey}`,
      });
      if (!recorded) throw new Error("successor Episode became terminal before supervisor input promotion");
    }
    this.options.db.setSetting(key, null);
  }

  private clearSuccessorIntent(predecessorGoalId?: string): void {
    const current = parseSuccessorIntent(this.options.db.getSetting(SUCCESSOR_INTENT_SETTING));
    if (!current) return;
    if (predecessorGoalId && current.predecessorGoalId !== predecessorGoalId) return;
    this.options.db.setSetting(SUCCESSOR_INTENT_SETTING, null);
  }

  async start(input: AutonomyControllerStartInput): Promise<{ goal: AutonomousGoal; created: boolean }> {
    const existing = activeGoals(this.options.db);
    if (existing.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous start");
    if (existing.length === 1) {
      const predecessor = latestTerminalGoal(this.options.db);
      if (predecessor) this.promoteSuccessorInputs(predecessor.goalId, existing[0].goalId);
      this.clearSuccessorIntent(predecessor?.goalId);
      this.startDrain(existing[0]);
      return { goal: existing[0], created: false };
    }

    this.options.engineForBot(input.bot);
    const predecessor = latestTerminalGoal(this.options.db);
    const prompt = predecessor ? predecessor.prompt : this.frozenPrompt(input.policyInstruction);
    const constraints = predecessor ? predecessor.constraints : [];
    const initialEvidence = predecessor
      ? [...predecessor.evidence, ...(input.initialEvidence ?? [])].slice(-8)
      : input.initialEvidence;
    const supervisorRoute = input.supervisorRoute ?? (predecessor ? getAutonomousSupervisorState(this.options.db, predecessor.goalId)?.route : undefined);
    const result = this.createEpisodeWithDailyReservation({
      goalId: `episode-${randomUUID()}`,
      prompt,
      constraints,
      bot: input.bot,
      maxCycles: input.maxCycles ?? predecessor?.maxCycles ?? this.options.maxCycles,
      initialEvidence,
      supervisorRoute,
    });
    if (result.created && predecessor) this.promoteSuccessorInputs(predecessor.goalId, result.goal.goalId);
    this.clearSuccessorIntent(predecessor?.goalId);
    this.startDrain(result.goal);
    return result;
  }

  status(): AutonomyControllerStatus {
    const active = activeGoals(this.options.db);
    if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous status");
    if (active.length === 1) return { state: "running", goal: active[0] };
    const latest = latestGoal(this.options.db);
    return latest ? { state: "terminal", goal: latest } : { state: "idle" };
  }

  statusText(): string {
    const status = this.status();
    const daily = `Episodes today ${this.episodesToday()}/${this.maxEpisodesPerDay} UTC; Episode approval ${this.requireEpisodeApproval ? "required" : "disabled"}.`;
    if (!status.goal) return `Autonomy: idle. ${daily}`;
    const intent = parseSuccessorIntent(this.options.db.getSetting(SUCCESSOR_INTENT_SETTING));
    const limitNote = intent && this.episodesToday() >= this.maxEpisodesPerDay ? " Daily Episode limit reached; no successor is eligible yet." : "";
    return status.state === "running"
      ? `Autonomy: running Episode ${status.goal.goalId}; cycle ${status.goal.cycle}/${status.goal.maxCycles}; provider ${status.goal.bot}. ${daily}`
      : `Autonomy: ${status.goal.status}; Episode ${status.goal.goalId}; cycles ${status.goal.cycle}/${status.goal.maxCycles}. ${daily}${limitNote}`;
  }

  async stop(reason = "owner stop"): Promise<AutonomousGoal | null> {
    this.options.db.setSetting(SUCCESSOR_INTENT_SETTING, null);
    const active = activeGoals(this.options.db);
    if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous stop");
    if (active.length === 0) {
      const terminal = latestTerminalGoal(this.options.db);
      if (terminal) this.options.db.setSetting(successorInputSettingKey(terminal.goalId), null);
      return latestGoal(this.options.db);
    }
    return cancelAutonomousGoal(this.options.db, active[0].goalId, reason);
  }

  recordSupervisorInput(input: { goalId: string; text: string; idempotencyKey: string; phase?: "active" | "successor" }): boolean {
    if (input.phase === "successor") {
      this.recordSuccessorInput(input);
      // Preserve the normal Telegram discussion path. The terminal Episode is
      // immutable; this call only captures bounded successor guidance.
      return false;
    }
    return recordAutonomousSupervisorInput(this.options.db, input);
  }

  resumeActive(): void {
    const active = activeGoals(this.options.db);
    if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous resume");
    if (active.length === 1) {
      const predecessor = latestTerminalGoal(this.options.db);
      if (predecessor) this.promoteSuccessorInputs(predecessor.goalId, active[0].goalId);
      this.clearSuccessorIntent(predecessor?.goalId);
      this.startDrain(active[0]);
      return;
    }
    if (!this.requireEpisodeApproval) void this.resumeSuccessorIntent();
  }

  private startDrain(goal: AutonomousGoal): void {
    if (goal.status !== "active" || this.draining.has(goal.goalId)) return;
    this.draining.add(goal.goalId);
    const engine = createSurfaceNeutralProviderRouter({
      db: this.options.db,
      initialProvider: goal.bot,
      providerChain: this.providerChain,
      engineForProvider: this.options.engineForBot,
    });
    void drainAutonomousGoal(this.options.db, goal.goalId, engine, (event) => this.onCycleReconciled(event))
      .catch((error) => this.options.log?.error?.("[autonomy] drain failed", error))
      .finally(() => this.draining.delete(goal.goalId));
  }

  private onCycleReconciled(event: CycleReconciledEvent): void {
    const terminal = event.goalStatus !== "active";
    if ((event.notify || terminal) && this.options.deliverSupervisorMessage) {
      const state = getAutonomousSupervisorState(this.options.db, event.goalId);
      if (state) {
        void this.options.deliverSupervisorMessage(state.route, event.evidence)
          .then((messageId) => recordAutonomousSupervisorMessageId(this.options.db, event.goalId, messageId))
          .catch((error) => this.options.log?.error?.("[autonomy] supervisor delivery failed", error));
      }
    }

    if (!this.requireEpisodeApproval
      && event.goalStatus === "budget_exhausted"
      && event.disposition === "continue") {
      this.options.db.setSetting(SUCCESSOR_INTENT_SETTING, JSON.stringify({ predecessorGoalId: event.goalId } satisfies SuccessorIntent));
      void this.resumeSuccessorIntent();
    }
  }

  private async resumeSuccessorIntent(): Promise<void> {
    if (this.resumingSuccessor) return;
    const intent = parseSuccessorIntent(this.options.db.getSetting(SUCCESSOR_INTENT_SETTING));
    if (!intent) return;
    this.resumingSuccessor = true;
    try {
      const active = activeGoals(this.options.db);
      if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous successor resume");
      if (active.length === 1) {
        this.promoteSuccessorInputs(intent.predecessorGoalId, active[0].goalId);
        this.clearSuccessorIntent(intent.predecessorGoalId);
        this.startDrain(active[0]);
        return;
      }

      const predecessor = getAutonomousGoal(this.options.db, intent.predecessorGoalId);
      if (predecessor.status !== "budget_exhausted") {
        this.clearSuccessorIntent(intent.predecessorGoalId);
        return;
      }
      try {
        await this.start({
          bot: predecessor.bot,
          maxCycles: predecessor.maxCycles,
          supervisorRoute: getAutonomousSupervisorState(this.options.db, predecessor.goalId)?.route,
        });
      } catch (error) {
        if (error instanceof AutonomyDailyEpisodeLimitError) return;
        throw error;
      }
    } catch (error) {
      this.options.log?.error?.("[autonomy] successor resume failed", error);
    } finally {
      this.resumingSuccessor = false;
    }
  }
}
