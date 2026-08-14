/**
 * PURPOSE: Bridge-owned Unix-socket broker for scoped, expiring agent advisor capabilities.
 * INPUTS: Trusted bridge configuration plus capability, mode, and task from an agent helper.
 * OUTPUTS: Formatted advisor guidance without exposing policy or provider authority to agents.
 * NEIGHBORS: src/advisor.ts, src/engine.ts, src/advisorCommand.ts
 */

import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatAdvisorResult } from "./advisor.js";
import { AdvisorEvidenceToolBroker, type AdvisorEvidenceAuditEvent } from "./advisorEvidenceTools.js";
import { AdvisorService } from "./advisorService.js";
import { assertChainSupportsProfile, chainSupportsProfile } from "./advisorPolicy.js";
import type { AdvisorConfig, AdvisorRequestMode, AdvisorResult } from "./advisorTypes.js";
import type { BridgeDb } from "./db.js";
import type { BotConfig, BotKind } from "./types.js";
import { parseAdvisorConfig } from "./advisorConfig.js";

const CAPABILITY_TTL_MS = 10 * 60_000;
const ALLOWED_MODES = new Set<AdvisorRequestMode>(["plan", "review", "debug", "risk", "decision"]);
const LOCAL_SOCKET_PATHS = new Map<string, string>();
const CONFIGURED_TRUSTED_SERVICES = new WeakMap<BridgeDb, AdvisorService>();
type RunCli = ConstructorParameters<typeof AdvisorService>[0]["runCli"];

export interface AdvisorCapabilityBinding {
  chatKey: string;
  cliKind: string;
  turnKey: string;
  taskKey: string;
  repoPath: string;
  activeModel: string | null;
}

export interface AdvisorCapabilityIssuer {
  issue(binding: AdvisorCapabilityBinding): string;
}

interface CapabilityRecord extends AdvisorCapabilityBinding { expiresAt: number }
interface BrokerRequest { capability: string; mode: AdvisorRequestMode; task: string }
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
  private readonly service: AdvisorService;
  private server: Server | null = null;
  private now = () => Date.now();

  constructor(private readonly deps: {
    db: BridgeDb;
    config: AdvisorConfig;
    bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
    runCli: RunCli;
    socketDir?: string;
  }) {
    this.socketPath = join(deps.socketDir ?? tmpdir(), `agent-bridge-advisor-${this.brokerId}.sock`);
    this.service = new AdvisorService({ db: deps.db, config: deps.config, bots: deps.bots, runCli: deps.runCli });
    LOCAL_SOCKET_PATHS.set(this.brokerId, this.socketPath);
    CONFIGURED_TRUSTED_SERVICES.set(deps.db, this.service);
  }

  setClockForTest(clock: () => number): void { this.now = clock; }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { input += chunk; });
      socket.on("end", () => {
        void this.handleWireRequest(input).then((response) => socket.end(`${JSON.stringify(response)}\n`));
      });
    });
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
    if (!this.deps.config.enabled || this.deps.config.chain.length === 0) {
      throw new Error("Advisor disabled or misconfigured");
    }
    assertChainSupportsProfile(this.deps.config.chain, this.service.executionProfile);
    const scope = binding.chatKey;
    const previous = this.activeByScope.get(scope);
    if (previous) this.capabilities.delete(previous);
    const capability = `${this.brokerId}.${randomBytes(32).toString("hex")}`;
    this.capabilities.set(capability, { ...binding, expiresAt: this.now() + CAPABILITY_TTL_MS });
    this.activeByScope.set(scope, capability);
    return capability;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    CONFIGURED_TRUSTED_SERVICES.delete(this.deps.db);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { unlinkSync(this.socketPath); } catch { /* already removed */ }
    LOCAL_SOCKET_PATHS.delete(this.brokerId);
  }

  /**
   * Untrusted entry point: authenticates the capability, reconstructs trusted
   * scope, then resolves into the same execution path as manual
   * requests via AdvisorService.requestTrusted().
   */
  async requestWithCapability(input: { capability: string; mode: AdvisorRequestMode; task: string }): Promise<string> {
    if (typeof input.capability !== "string") throw new Error("Invalid capability");
    if (!ALLOWED_MODES.has(input.mode)) throw new Error("Invalid advisor mode");
    if (typeof input.task !== "string" || !input.task.trim()) throw new Error("Advisor task is required");
    const binding = this.capabilities.get(input.capability);
    if (!binding) throw new Error("Invalid capability");
    if (this.now() > binding.expiresAt) {
      this.capabilities.delete(input.capability);
      throw new Error("Expired capability");
    }
    const result = await this.service.requestTrusted({
      origin: "manual",
      scopeKey: binding.chatKey,
      turnKey: binding.turnKey,
      taskKey: binding.taskKey,
      mode: input.mode,
      task: input.task.trim(),
      activeProvider: binding.cliKind,
      activeModel: binding.activeModel,
      cwd: binding.repoPath,
    });
    return formatAdvisorResult(result);
  }

  private async handleWireRequest(raw: string): Promise<BrokerResponse> {
    try {
      const input = JSON.parse(raw) as Partial<BrokerRequest>;
      const output = await this.requestWithCapability({
        capability: input.capability as string,
        mode: input.mode as AdvisorRequestMode,
        task: input.task as string,
      });
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
): Promise<string> {
  const socketPath = socketPathFor(input.capability, socketDir);
  const response = await new Promise<BrokerResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => {
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
  if (!chainSupportsProfile(config.chain, "tool_free")) {
    console.warn("[advisor] agent-direct access disabled: every target must support tool-free mode");
    return null;
  }
  const broker = new AdvisorBroker({ db: deps.db, config, bots: deps.bots, runCli: deps.runCli });
  await broker.start();
  return broker;
}
