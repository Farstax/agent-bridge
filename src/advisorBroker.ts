/** Bridge-owned Unix-socket capability for one bounded cross-provider frontier opinion. */
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { abortCliProcessAndWait } from "./cli.js";
import { executeFrontierAdvice } from "./advisor.js";
import { supportsToolFreeMode } from "./providers/registry.js";
import type { AdvisorConfig } from "./advisorTypes.js";
import type { BridgeDb } from "./db.js";
import type { BotConfig, BotKind } from "./types.js";
import { parseAdvisorConfig } from "./advisorConfig.js";

const CAPABILITY_TTL_MS = 10 * 60_000;
const LOCAL_SOCKET_PATHS = new Map<string, string>();
type RunCli = (command: string, args: string[], cwd: string, options: Record<string, unknown>) => Promise<string>;
type AbortCli = (executionId: string) => Promise<boolean>;

export interface AdvisorCapabilityBinding {
  chatKey: string;
  cliKind: string;
  turnKey: string;
  taskKey: string;
  repoPath: string;
  activeModel?: string | null;
}
export interface AdvisorCapabilityIssuer { issue(binding: AdvisorCapabilityBinding): string }
interface CapabilityRecord extends AdvisorCapabilityBinding { expiresAt: number }
interface BrokerRequest {
  capability: string;
  question?: string;
  context?: string;
  provider?: string;
  /** Legacy spellings accepted only so old installed helpers fail soft during rollout. */
  task?: string;
  mode?: string;
}
interface BrokerResponse { ok: boolean; output?: string; error?: string }

function socketPathFor(capability: string, socketDir = tmpdir()): string {
  const brokerId = capability.split(".", 1)[0];
  if (!/^[a-f0-9]{24}$/.test(brokerId)) throw new Error("Invalid capability");
  return LOCAL_SOCKET_PATHS.get(brokerId) ?? join(socketDir, `agent-bridge-advisor-${brokerId}.sock`);
}

export class AdvisorBroker implements AdvisorCapabilityIssuer {
  private readonly brokerId = randomBytes(12).toString("hex");
  private readonly socketPath: string;
  private readonly capabilities = new Map<string, CapabilityRecord>();
  private readonly activeByScope = new Map<string, string>();
  private readonly abortCli: AbortCli;
  private server: Server | null = null;
  private now = () => Date.now();

  constructor(private readonly deps: {
    db: BridgeDb;
    config: AdvisorConfig;
    bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
    runCli: RunCli;
    socketDir?: string;
    abortCli?: AbortCli;
  }) {
    this.socketPath = join(deps.socketDir ?? tmpdir(), `agent-bridge-advisor-${this.brokerId}.sock`);
    this.abortCli = deps.abortCli ?? abortCliProcessAndWait;
    LOCAL_SOCKET_PATHS.set(this.brokerId, this.socketPath);
  }

  setClockForTest(clock: () => number): void { this.now = clock; }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  issue(binding: AdvisorCapabilityBinding): string {
    if (!this.deps.config.enabled || this.deps.config.chain.length === 0) throw new Error("Advisor disabled or misconfigured");
    if (!this.deps.config.chain.every((target) => supportsToolFreeMode(target.provider))) {
      throw new Error("Advisor target does not support tool-free mode");
    }
    const previous = this.activeByScope.get(binding.chatKey);
    if (previous) this.capabilities.delete(previous);
    const capability = `${this.brokerId}.${randomBytes(32).toString("hex")}`;
    this.capabilities.set(capability, { ...binding, expiresAt: this.now() + CAPABILITY_TTL_MS });
    this.activeByScope.set(binding.chatKey, capability);
    return capability;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { unlinkSync(this.socketPath); } catch { /* already removed */ }
    LOCAL_SOCKET_PATHS.delete(this.brokerId);
  }

  async requestWithCapability(input: BrokerRequest, onExecutionId?: (executionId: string) => void): Promise<string> {
    if (typeof input.capability !== "string") throw new Error("Invalid capability");
    const binding = this.capabilities.get(input.capability);
    if (!binding) throw new Error("Invalid capability");
    if (this.now() > binding.expiresAt) {
      this.capabilities.delete(input.capability);
      throw new Error("Expired capability");
    }
    const executionId = `advisor:${randomUUID()}`;
    onExecutionId?.(executionId);
    const result = await executeFrontierAdvice({
      db: this.deps.db,
      config: this.deps.config,
      bots: this.deps.bots,
      runCli: this.deps.runCli,
      request: {
        scopeKey: binding.chatKey,
        turnKey: binding.turnKey,
        taskKey: binding.taskKey,
        activeProvider: binding.cliKind,
        provider: input.provider,
        question: input.question ?? input.task ?? "",
        context: input.context,
        cwd: binding.repoPath,
        executionId,
      },
    });
    return result.text;
  }

  private accept(socket: Socket): void {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("end", () => {
      let settled = false;
      let executionId: string | null = null;
      const cancel = () => {
        if (!settled && executionId) void this.abortCli(executionId);
      };
      socket.once("close", cancel);
      void this.handleWireRequest(input, (id) => { executionId = id; }).then((response) => {
        settled = true;
        socket.off("close", cancel);
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  }

  private async handleWireRequest(raw: string, onExecutionId: (id: string) => void): Promise<BrokerResponse> {
    try {
      const input = JSON.parse(raw) as BrokerRequest;
      const output = await this.requestWithCapability(input, onExecutionId);
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export async function requestAdvisorViaBroker(
  input: BrokerRequest,
  _untrustedEnv: Record<string, string | undefined> = process.env,
  socketDir = tmpdir(),
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Advisor request aborted");
  const socketPath = socketPathFor(input.capability, socketDir);
  const response = await new Promise<BrokerResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    const abort = () => socket.destroy(new Error("Advisor request aborted"));
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("error", (error) => { cleanup(); reject(error); });
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => {
      cleanup();
      try { resolve(JSON.parse(output) as BrokerResponse); }
      catch { reject(new Error("Invalid advisor broker response")); }
    });
    socket.end(JSON.stringify(input));
  });
  if (!response.ok) throw new Error(response.error || "Advisor broker request failed");
  return response.output ?? "";
}

export async function startConfiguredAdvisorBroker(deps: {
  db: BridgeDb;
  bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
  runCli: RunCli;
  env?: Record<string, string | undefined>;
}): Promise<AdvisorBroker | null> {
  const config = parseAdvisorConfig(deps.env ?? process.env);
  if (!config.enabled || config.chain.length === 0) return null;
  if (!config.chain.every((target) => supportsToolFreeMode(target.provider))) {
    console.warn("[advisor] agent-direct access disabled: configured target lacks tool-free mode");
    return null;
  }
  const broker = new AdvisorBroker({ db: deps.db, config, bots: deps.bots, runCli: deps.runCli });
  await broker.start();
  return broker;
}
