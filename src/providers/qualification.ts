import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCliInvocation, parseCliResult, runCli } from "../cli.js";
import { runSupervisedProcess } from "../cliSupervisor.js";
import type { BotKind } from "../types.js";
import { withAntigravityStateLock } from "./antigravityRuntime.js";
import { classifyProviderError } from "./errorClassification.js";
import { getProcessWatchForCommand, getProviderAdapter } from "./registry.js";
import type { ProviderId } from "./types.js";

export const PROVIDER_CONTRACT_VERSION = 1;

export type QualificationCheckStatus =
  | "pass"
  | "fail"
  | "not_applicable"
  | "unsupported"
  | "not_authenticated";

export interface ProviderQualificationCheck {
  name: "version" | "fresh_prompt" | "session_resume";
  status: QualificationCheckStatus;
  diagnostic?: string;
}

export interface ProviderQualificationRecord {
  provider: ProviderId;
  providerVersion: string;
  previousVersion: string | null;
  bridgeCommit: string;
  contractVersion: number;
  qualifiedAt: string;
  environment: string;
  overall: "pass" | "degraded" | "fail";
  checks: ProviderQualificationCheck[];
}

export interface ProviderQualificationEvidence {
  schemaVersion: 1;
  contractVersion: number;
  updatedAt: string;
  providers: Partial<Record<ProviderId, ProviderQualificationRecord>>;
}

export interface ProviderQualificationOptions {
  providerId: ProviderId;
  executable?: string;
  evidencePath?: string;
  expectedVersion?: string;
  previousVersion?: string | null;
  bridgeCommit?: string;
  environment?: string;
  cwd?: string;
  homeDir?: string;
  timeoutMs?: number;
}

export interface QualificationHealthResult {
  status: "green" | "amber" | "red";
  message: string;
}

const FRESH_MARKER = "AGENT_BRIDGE_QUALIFICATION_OK";
const RESUME_MARKER = "AGENT_BRIDGE_QUALIFICATION_RESUME_OK";

function providerBotKind(providerId: ProviderId): BotKind {
  return providerId === "agy" ? "antigravity" : providerId;
}

export function normalizeProviderVersion(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] ?? trimmed;
}

export function qualificationEvidencePath(homeDir: string = homedir()): string {
  return process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH
    ?? join(homeDir, ".agent-bridge", "provider-qualification.json");
}

function emptyEvidence(): ProviderQualificationEvidence {
  return {
    schemaVersion: 1,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    updatedAt: new Date(0).toISOString(),
    providers: {},
  };
}

function isQualificationRecord(value: unknown): value is ProviderQualificationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ProviderQualificationRecord>;
  return typeof record.provider === "string"
    && typeof record.providerVersion === "string"
    && typeof record.bridgeCommit === "string"
    && typeof record.contractVersion === "number"
    && typeof record.qualifiedAt === "string"
    && typeof record.environment === "string"
    && (record.overall === "pass" || record.overall === "degraded" || record.overall === "fail")
    && Array.isArray(record.checks);
}

export function readQualificationEvidence(path: string = qualificationEvidencePath()): ProviderQualificationEvidence {
  if (!existsSync(path)) return emptyEvidence();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`provider qualification evidence is unreadable: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("provider qualification evidence must be an object");
  }
  const candidate = parsed as Partial<ProviderQualificationEvidence>;
  if (candidate.schemaVersion !== 1 || typeof candidate.contractVersion !== "number" || !candidate.providers || typeof candidate.providers !== "object") {
    throw new Error("provider qualification evidence has an unsupported schema");
  }
  for (const record of Object.values(candidate.providers)) {
    if (record != null && !isQualificationRecord(record)) {
      throw new Error("provider qualification evidence contains an invalid provider record");
    }
  }
  return candidate as ProviderQualificationEvidence;
}

export function writeQualificationRecord(
  record: ProviderQualificationRecord,
  path: string = qualificationEvidencePath(),
): void {
  let evidence: ProviderQualificationEvidence;
  try {
    evidence = readQualificationEvidence(path);
  } catch {
    evidence = emptyEvidence();
  }
  const next: ProviderQualificationEvidence = {
    schemaVersion: 1,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    updatedAt: record.qualifiedAt,
    providers: {
      ...evidence.providers,
      [record.provider]: record,
    },
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function isQualificationCurrent(
  record: ProviderQualificationRecord | null | undefined,
  providerId: ProviderId,
  installedVersion: string,
): boolean {
  return Boolean(record
    && record.provider === providerId
    && record.providerVersion === normalizeProviderVersion(installedVersion)
    && record.contractVersion === PROVIDER_CONTRACT_VERSION);
}

function failedCheckNames(record: ProviderQualificationRecord): string[] {
  return record.checks.filter((check) => check.status === "fail").map((check) => check.name);
}

export function qualificationHealthCheck(
  providerId: ProviderId,
  installedVersion: string,
  evidencePath: string = qualificationEvidencePath(),
): QualificationHealthResult {
  const version = normalizeProviderVersion(installedVersion);
  let evidence: ProviderQualificationEvidence;
  try {
    evidence = readQualificationEvidence(evidencePath);
  } catch (error) {
    return { status: "red", message: `${providerId} qualification evidence unreadable: ${(error as Error).message}` };
  }
  const record = evidence.providers[providerId];
  if (!isQualificationCurrent(record, providerId, version)) {
    return {
      status: "amber",
      message: `${providerId} ${version} unqualified for provider contract v${PROVIDER_CONTRACT_VERSION}`,
    };
  }
  if (record!.overall === "pass") {
    return {
      status: "green",
      message: `${providerId} ${version} qualified for provider contract v${PROVIDER_CONTRACT_VERSION}`,
    };
  }
  const failures = failedCheckNames(record!);
  const detail = failures.length > 0 ? failures.join(", ") : "prerequisite unavailable";
  return {
    status: record!.overall === "fail" ? "red" : "amber",
    message: `${providerId} ${version} degraded — ${detail}`,
  };
}

function checkForError(providerId: ProviderId, error: Error): {
  check: ProviderQualificationCheck;
  overall: "degraded" | "fail";
} {
  const classification = classifyProviderError(providerId, error);
  if (classification.kind === "auth_required") {
    return {
      check: { name: "fresh_prompt", status: "not_authenticated", diagnostic: error.message.slice(0, 500) },
      overall: "degraded",
    };
  }
  const externalConstraint = classification.kind === "capacity_exhausted"
    || classification.kind === "model_unavailable"
    || classification.kind === "transient";
  return {
    check: { name: "fresh_prompt", status: "fail", diagnostic: error.message.slice(0, 500) },
    overall: externalConstraint ? "degraded" : "fail",
  };
}

function resolveBridgeCommit(cwd: string): string {
  const configured = process.env.AGENT_BRIDGE_COMMIT
    ?? process.env.BRIDGE_COMMIT
    ?? process.env.BRIDGE_RELEASE_COMMIT;
  if (configured?.trim()) return configured.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
  } catch {
    return "unknown";
  }
}

async function runQualificationInvocation({
  providerId,
  command,
  args,
  cwd,
  homeDir,
  timeoutMs,
}: {
  providerId: ProviderId;
  command: string;
  args: string[];
  cwd: string;
  homeDir: string;
  timeoutMs: number;
}): Promise<string> {
  const bot = providerBotKind(providerId);
  if (providerId !== "agy") {
    return runCli(command, args, cwd, {
      bot,
      timeoutMs,
      idleTimeoutMs: timeoutMs,
      killGraceMs: 1_000,
    });
  }

  // Production Agy execution deliberately recovers a usable provider error from
  // a non-zero ERROR envelope that also contains partial response text. That is
  // correct runtime behavior, but qualification must additionally detect the raw
  // envelope contradiction as provider-contract drift. Keep the same invocation,
  // supervisor, process watch, state lock and strict result parser; only bypass
  // the runtime recovery shim so the provider's raw native JSON remains visible.
  return withAntigravityStateLock(homeDir, async () => {
    try {
      const result = await runSupervisedProcess(command, args, cwd, {
        bot,
        timeoutMs,
        idleTimeoutMs: timeoutMs,
        killGraceMs: 1_000,
        processWatch: getProcessWatchForCommand(command),
      });
      return result.stdout;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const stdout = (error as Error & { stdout?: string }).stdout ?? "";
      if (stdout.trim()) {
        // A valid ERROR envelope throws a classifiable provider error here; a
        // contradictory ERROR + response envelope throws the stricter contract
        // error before runtime recovery can normalize it.
        parseCliResult({ bot, stdout });
      }
      throw error;
    }
  });
}

async function executePromptCheck({
  providerId,
  executable,
  cwd,
  homeDir,
  timeoutMs,
  sessionId,
  marker,
}: {
  providerId: ProviderId;
  executable: string;
  cwd: string;
  homeDir: string;
  timeoutMs: number;
  sessionId: string | null;
  marker: string;
}): Promise<{ sessionId: string | null }> {
  const bot = providerBotKind(providerId);
  const adapter = getProviderAdapter(providerId);
  const invocation = buildCliInvocation({
    bot,
    prompt: `Reply with exactly ${marker} and nothing else.`,
    sessionId,
    command: executable,
    model: null,
    executionMode: "safe",
    outputFormat: providerId === "kimchi" ? null : "json",
    soulContext: null,
    includeResponseContract: false,
    attachments: [],
    outputDir: null,
    effort: null,
    homeDir,
    toolMode: adapter.capabilities.toolFree ? "none" : "default",
  });
  const stdout = await runQualificationInvocation({
    providerId,
    command: invocation.command,
    args: invocation.args,
    cwd,
    homeDir,
    timeoutMs,
  });
  const parsed = parseCliResult({ bot, stdout });
  if (!parsed.text.includes(marker)) {
    throw new Error(`provider response did not contain qualification marker ${marker}`);
  }
  return { sessionId: parsed.sessionId };
}

export async function qualifyProvider(options: ProviderQualificationOptions): Promise<ProviderQualificationRecord> {
  const adapter = getProviderAdapter(options.providerId);
  const executable = options.executable ?? adapter.executable;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const homeDir = options.homeDir ?? homedir();
  const ownsWorkspace = !options.cwd;
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), `agent-bridge-qualify-${options.providerId}-`));
  const evidencePath = options.evidencePath ?? qualificationEvidencePath(homeDir);
  const qualifiedAt = new Date().toISOString();
  const checks: ProviderQualificationCheck[] = [];
  let providerVersion = options.expectedVersion ? normalizeProviderVersion(options.expectedVersion) : "unknown";
  let overall: ProviderQualificationRecord["overall"] = "pass";
  const previousAgyMode = process.env.ANTIGRAVITY_OUTPUT_MODE;

  try {
    if (options.providerId === "agy") process.env.ANTIGRAVITY_OUTPUT_MODE = "json";

    try {
      const versionOutput = execFileSync(executable, ["--version"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: Math.min(timeoutMs, 10_000),
      }).trim();
      providerVersion = normalizeProviderVersion(versionOutput);
      if (options.expectedVersion && providerVersion !== normalizeProviderVersion(options.expectedVersion)) {
        throw new Error(`installed version mismatch: expected ${normalizeProviderVersion(options.expectedVersion)}, observed ${providerVersion}`);
      }
      checks.push({ name: "version", status: "pass", diagnostic: versionOutput.slice(0, 200) });
    } catch (error) {
      checks.push({ name: "version", status: "fail", diagnostic: (error as Error).message.slice(0, 500) });
      checks.push({ name: "fresh_prompt", status: "not_applicable" });
      checks.push({ name: "session_resume", status: "not_applicable" });
      overall = "fail";
      const record: ProviderQualificationRecord = {
        provider: options.providerId,
        providerVersion,
        previousVersion: options.previousVersion ?? null,
        bridgeCommit: options.bridgeCommit ?? resolveBridgeCommit(cwd),
        contractVersion: PROVIDER_CONTRACT_VERSION,
        qualifiedAt,
        environment: options.environment ?? process.env.AGENT_BRIDGE_ENVIRONMENT_CLASS ?? "managed-appliance",
        overall,
        checks,
      };
      writeQualificationRecord(record, evidencePath);
      return record;
    }

    let freshSessionId: string | null = null;
    try {
      const fresh = await executePromptCheck({
        providerId: options.providerId,
        executable,
        cwd,
        homeDir,
        timeoutMs,
        sessionId: null,
        marker: FRESH_MARKER,
      });
      freshSessionId = fresh.sessionId;
      checks.push({ name: "fresh_prompt", status: "pass" });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const failure = checkForError(options.providerId, error);
      checks.push(failure.check);
      checks.push({ name: "session_resume", status: "not_applicable" });
      overall = failure.overall;
    }

    if (checks.some((check) => check.name === "fresh_prompt" && check.status === "pass")) {
      if (!freshSessionId) {
        checks.push({ name: "session_resume", status: "not_applicable", diagnostic: "provider did not expose an invocation-attributable session id" });
      } else {
        try {
          await executePromptCheck({
            providerId: options.providerId,
            executable,
            cwd,
            homeDir,
            timeoutMs,
            sessionId: freshSessionId,
            marker: RESUME_MARKER,
          });
          checks.push({ name: "session_resume", status: "pass" });
        } catch (caught) {
          const error = caught instanceof Error ? caught : new Error(String(caught));
          const classification = classifyProviderError(options.providerId, error);
          checks.push({ name: "session_resume", status: "fail", diagnostic: error.message.slice(0, 500) });
          overall = classification.kind === "capacity_exhausted"
            || classification.kind === "model_unavailable"
            || classification.kind === "transient"
            ? "degraded"
            : "fail";
        }
      }
    }

    const record: ProviderQualificationRecord = {
      provider: options.providerId,
      providerVersion,
      previousVersion: options.previousVersion ?? null,
      bridgeCommit: options.bridgeCommit ?? resolveBridgeCommit(cwd),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt,
      environment: options.environment ?? process.env.AGENT_BRIDGE_ENVIRONMENT_CLASS ?? "managed-appliance",
      overall,
      checks,
    };
    writeQualificationRecord(record, evidencePath);
    return record;
  } finally {
    if (options.providerId === "agy") {
      if (previousAgyMode === undefined) delete process.env.ANTIGRAVITY_OUTPUT_MODE;
      else process.env.ANTIGRAVITY_OUTPUT_MODE = previousAgyMode;
    }
    if (ownsWorkspace) rmSync(cwd, { recursive: true, force: true });
  }
}

export async function qualifyProviderIfNeeded(
  options: ProviderQualificationOptions & { installedVersion: string },
): Promise<{ record: ProviderQualificationRecord; ran: boolean }> {
  const evidencePath = options.evidencePath ?? qualificationEvidencePath(options.homeDir ?? homedir());
  const evidence = readQualificationEvidence(evidencePath);
  const current = evidence.providers[options.providerId];
  if (isQualificationCurrent(current, options.providerId, options.installedVersion)) {
    return { record: current!, ran: false };
  }
  const record = await qualifyProvider({
    ...options,
    evidencePath,
    expectedVersion: options.installedVersion,
    previousVersion: options.previousVersion ?? current?.providerVersion ?? null,
  });
  return { record, ran: true };
}
