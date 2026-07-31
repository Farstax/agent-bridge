import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { redactAdvisorEvidenceText } from "./advisorEvidenceRedaction.js";

export type AdvisorEvidenceToolName =
  | "repo.list_files"
  | "repo.read_file"
  | "repo.search_text"
  | "git.status"
  | "git.diff"
  | "git.show"
  | "git.log"
  | "evidence.acceptance"
  | "evidence.plan"
  | "evidence.test_failures"
  | "evidence.attempt_summary";

export type AdvisorEvidenceToolRequest =
  | { tool: "repo.list_files"; path?: string; depth?: number }
  | { tool: "repo.read_file"; path: string }
  | { tool: "repo.search_text"; query: string; path?: string }
  | { tool: "git.status"; repoPath?: string }
  | { tool: "git.diff"; scope?: "working" | "staged" | "base_to_head"; base?: string; head?: string; repoPath?: string }
  | { tool: "git.show"; object: string; path?: string; repoPath?: string }
  | { tool: "git.log"; count?: number; repoPath?: string }
  | { tool: "evidence.acceptance" }
  | { tool: "evidence.plan" }
  | { tool: "evidence.test_failures" }
  | { tool: "evidence.attempt_summary" };

export interface AdvisorEvidenceToolResult {
  evidenceId: string;
  tool: AdvisorEvidenceToolName;
  /** Bounded, sanitised provenance that lets later reasoning distinguish evidence sources. */
  source: string;
  status: "ok" | "denied" | "failed" | "unavailable" | "exhausted";
  summary: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface AdvisorEvidenceAuditEvent {
  tool: AdvisorEvidenceToolName;
  status: AdvisorEvidenceToolResult["status"];
  evidenceId: string;
  durationMs: number;
  bytes: number;
  truncated: boolean;
  arguments: Record<string, string | number | boolean>;
  /** Invoking CLI working directory relative paths resolve against (Issue #229 Part 2). */
  cwd: string;
  /** Filesystem scope root — "/", bounded only by OS read permissions for the service user. */
  scopeRoot: string;
}

export interface AdvisorEvidenceToolLimits {
  maxCalls: number;
  maxResultBytes: number;
  maxAggregateBytes: number;
  maxFiles: number;
  maxEntries: number;
  maxMatches: number;
  maxDepth: number;
  timeoutMs: number;
}

export interface AdvisorWorkerEvidence {
  acceptance?: string;
  plan?: string;
  testFailures?: string;
  attemptSummary?: string;
}

type RunGit = (
  args: string[],
  cwd: string,
  options: { timeoutMs: number },
) => string | Promise<string>;

interface EvidencePayload {
  content: string;
  complete: boolean;
  limitation?: string;
}

interface FileCollection {
  files: string[];
  complete: boolean;
  limitations: Set<string>;
}

const execFileAsync = promisify(execFile);

// Issue #229 Part 2: the advisor has the same read visibility as the
// invoking CLI process under the same Unix account — bounded only by
// normal OS file permissions, not by repo containment or an allowlist.
const ADVISOR_FILESYSTEM_SCOPE_ROOT = "/";

const DEFAULT_LIMITS: AdvisorEvidenceToolLimits = {
  maxCalls: 6,
  maxResultBytes: 8_000,
  maxAggregateBytes: 30_000,
  maxFiles: 120,
  maxEntries: 500,
  maxMatches: 60,
  maxDepth: 5,
  timeoutMs: 5_000,
};

const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
]);

const GIT_READ_PREFIX = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
];

function hasSensitivePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean).map((part) => part.toLowerCase());
  const base = parts.at(-1) ?? "";
  if (parts.includes(".git")) return true;
  if (base.startsWith(".env")) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;
  if (parts.includes(".ssh") || parts.includes("workspace-secrets") || parts.includes("secrets")) return true;
  return /(?:^|[._-])(?:token|secret|credential)(?:s)?(?:[._-]|$)/i.test(base);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

// Issue #229 Part 2: the advisor's filesystem scope root is "/" — any path
// readable by the service Unix account, not just the invoking repo. Relative
// paths still resolve against the invoking CLI cwd; absolute paths are
// accepted as-is. The only remaining boundary is the operating system's own
// read permission, checked at access time by resolveExisting/resolveRepoRoot.
function safePathInput(value: unknown, field: string, optional = false): string {
  if (value == null && optional) return ".";
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty path`);
  if (value.includes("\0")) throw new Error(`${field} must not contain null bytes`);
  const normalized = normalize(value).replaceAll("\\", "/");
  if (hasSensitivePath(normalized)) throw new Error(`${field} targets a sensitive path`);
  return normalized === "" ? "." : normalized;
}

function safeAbsoluteRepoPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty absolute path`);
  if (value.includes("\0")) throw new Error(`${field} must not contain null bytes`);
  if (!isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
  return normalize(value);
}

function safeGitRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) {
    throw new Error(`${field} is not a supported Git object`);
  }
  if (value.startsWith("-") || value.includes("..") || value.includes("@{") || value.endsWith("/")) {
    throw new Error(`${field} is not a supported Git object`);
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  while (text.endsWith("�")) text = text.slice(0, -1);
  return { text, truncated: true };
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || key === "SSH_ASKPASS") continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.LC_ALL = "C";
  return env;
}

function descriptorHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeSourcePath(path: string): string {
  return hasSensitivePath(path) ? `path_sha256=${descriptorHash(path)}` : `path=${path}`;
}

function sourceDescriptor(request: AdvisorEvidenceToolRequest): string {
  switch (request.tool) {
    case "repo.list_files":
      return `repo.list_files ${safeSourcePath(request.path ?? ".")} depth=${request.depth ?? 3}`;
    case "repo.read_file":
      return `repo.read_file ${safeSourcePath(request.path)}`;
    case "repo.search_text":
      return `repo.search_text ${safeSourcePath(request.path ?? ".")} query_sha256=${descriptorHash(request.query)} query_chars=${request.query.length}`;
    case "git.status":
      return "git.status worktree";
    case "git.diff":
      return request.scope === "base_to_head"
        ? `git.diff scope=base_to_head base_sha256=${descriptorHash(request.base ?? "")} head_sha256=${descriptorHash(request.head ?? "")}`
        : `git.diff scope=${request.scope ?? "working"}`;
    case "git.show":
      return `git.show object_sha256=${descriptorHash(request.object)}${request.path ? ` ${safeSourcePath(request.path)}` : ""}`;
    case "git.log":
      return `git.log count=${request.count ?? 10}`;
    case "evidence.acceptance":
    case "evidence.plan":
    case "evidence.test_failures":
    case "evidence.attempt_summary":
      return request.tool;
  }
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function gitMetadataPaths(line: string): string[] {
  let match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (match) return [match[1], match[2]].map(unquoteGitPath);
  match = line.match(/^(?:---|\+\+\+) (?:a|b)\/(.+)$/);
  if (match) return [unquoteGitPath(match[1])];
  match = line.match(/^(?:rename|copy) (?:from|to) (.+)$/);
  if (match) return [unquoteGitPath(match[1])];
  if (!line.startsWith("## ")) {
    match = line.match(/^[ MADRCU?!]{2}\s+(.+)$/);
    if (match) return match[1].split(/\s+->\s+/).map(unquoteGitPath);
  }
  match = line.match(/^\s*(.+?)\s+\|\s+\d+/);
  if (match) return [unquoteGitPath(match[1])];
  return [];
}

function sanitiseGitEvidence(raw: string): EvidencePayload {
  const kept: string[] = [];
  let omitted = false;
  let skipDiffBlock = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      skipDiffBlock = gitMetadataPaths(line).some(hasSensitivePath);
      if (skipDiffBlock) {
        omitted = true;
        continue;
      }
      kept.push(line);
      continue;
    }
    if (skipDiffBlock) continue;
    if (gitMetadataPaths(line).some(hasSensitivePath)) {
      omitted = true;
      continue;
    }
    kept.push(line);
  }
  return {
    content: kept.join("\n").trim(),
    complete: !omitted,
    limitation: omitted ? "sensitive Git paths were omitted" : undefined,
  };
}

export function parseAdvisorEvidenceToolRequest(value: unknown): AdvisorEvidenceToolRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Advisor tool request must be an object");
  const input = value as Record<string, unknown>;
  switch (input.tool) {
    case "repo.list_files":
      return {
        tool: "repo.list_files",
        path: safePathInput(input.path, "path", true),
        depth: boundedInteger(input.depth, 3, 0, 8),
      };
    case "repo.read_file":
      return { tool: "repo.read_file", path: safePathInput(input.path, "path") };
    case "repo.search_text": {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) {
        throw new Error("query must be a non-empty literal of at most 200 characters");
      }
      return { tool: "repo.search_text", query: input.query, path: safePathInput(input.path, "path", true) };
    }
    case "git.status":
      return { tool: "git.status", ...(input.repoPath == null ? {} : { repoPath: safeAbsoluteRepoPath(input.repoPath, "repoPath") }) };
    case "git.diff": {
      const scope = input.scope == null ? "working" : input.scope;
      if (!(["working", "staged", "base_to_head"] as unknown[]).includes(scope)) throw new Error("Unsupported git.diff scope");
      const repoPath = input.repoPath == null ? undefined : safeAbsoluteRepoPath(input.repoPath, "repoPath");
      if (scope === "base_to_head") {
        return {
          tool: "git.diff", scope, base: safeGitRef(input.base, "base"), head: safeGitRef(input.head, "head"),
          ...(repoPath == null ? {} : { repoPath }),
        };
      }
      return { tool: "git.diff", scope: scope as "working" | "staged", ...(repoPath == null ? {} : { repoPath }) };
    }
    case "git.show": {
      const path = input.path == null ? undefined : safePathInput(input.path, "path");
      if (path?.includes(":")) throw new Error("path is not supported for git.show");
      const repoPath = input.repoPath == null ? undefined : safeAbsoluteRepoPath(input.repoPath, "repoPath");
      return {
        tool: "git.show",
        object: safeGitRef(input.object, "object"),
        ...(path == null ? {} : { path }),
        ...(repoPath == null ? {} : { repoPath }),
      };
    }
    case "git.log":
      return {
        tool: "git.log", count: boundedInteger(input.count, 10, 1, 20),
        ...(input.repoPath == null ? {} : { repoPath: safeAbsoluteRepoPath(input.repoPath, "repoPath") }),
      };
    case "evidence.acceptance":
    case "evidence.plan":
    case "evidence.test_failures":
    case "evidence.attempt_summary":
      return { tool: input.tool };
    default:
      throw new Error("Unsupported advisor evidence tool");
  }
}

export class AdvisorEvidenceToolBroker {
  private readonly rootPromise: Promise<string>;
  private readonly limits: AdvisorEvidenceToolLimits;
  private calls = 0;
  private aggregateBytes = 0;

  constructor(private readonly options: {
    repoPath: string;
    runGit?: RunGit;
    evidence?: AdvisorWorkerEvidence;
    limits?: Partial<AdvisorEvidenceToolLimits>;
    audit?: (event: AdvisorEvidenceAuditEvent) => void;
  }) {
    this.rootPromise = realpath(options.repoPath);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async execute(requests: AdvisorEvidenceToolRequest[]): Promise<AdvisorEvidenceToolResult[]> {
    if (requests.length > this.limits.maxCalls) throw new Error(`Advisor evidence tool limit exceeded: ${requests.length}/${this.limits.maxCalls}`);
    const results: AdvisorEvidenceToolResult[] = [];
    for (const request of requests) results.push(await this.executeOne(request));
    return results;
  }

  private async executeOne(request: AdvisorEvidenceToolRequest): Promise<AdvisorEvidenceToolResult> {
    const startedAt = Date.now();
    const deadline = startedAt + this.limits.timeoutMs;
    this.calls += 1;
    if (this.calls > this.limits.maxCalls) {
      return this.result(request, "exhausted", "Tool-call budget exhausted", { content: "", complete: false }, startedAt);
    }
    try {
      const payload = await this.perform(request, deadline);
      return this.result(request, "ok", "Read-only evidence collected", payload, startedAt);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const denied = /escape|sensitive|symlink|binary|must stay inside|relative path|unsupported git object|not supported for git\.show/i.test(error.message);
      const unavailable = /unavailable/i.test(error.message);
      const exhausted = /timeout|deadline|budget exhausted/i.test(error.message);
      return this.result(
        request,
        denied ? "denied" : unavailable ? "unavailable" : exhausted ? "exhausted" : "failed",
        redactAdvisorEvidenceText(error.message),
        { content: "", complete: !exhausted },
        startedAt,
      );
    }
  }

  private async beforeDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Advisor evidence tool deadline exhausted");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Advisor evidence tool timeout")), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Issue #229 Part 2: any filesystem operation that fails because the OS
  // denies or can't find the target must surface as a clear "unavailable"
  // result, never a silent fallback or an opaque generic failure.
  private async beforeDeadlineUnavailable<T>(
    label: string,
    operation: () => Promise<T>,
    deadline: number,
  ): Promise<T> {
    try {
      return await this.beforeDeadline(operation, deadline);
    } catch (caught) {
      if (caught instanceof Error && /timeout|deadline/i.test(caught.message)) throw caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`${label} is unavailable: ${message}`);
    }
  }

  private result(
    request: AdvisorEvidenceToolRequest,
    status: AdvisorEvidenceToolResult["status"],
    summary: string,
    payload: EvidencePayload,
    startedAt: number,
  ): AdvisorEvidenceToolResult {
    const remaining = Math.max(0, this.limits.maxAggregateBytes - this.aggregateBytes);
    const maxBytes = Math.min(this.limits.maxResultBytes, remaining);
    const bounded = truncateUtf8(redactAdvisorEvidenceText(payload.content), maxBytes);
    const content = maxBytes > 0 ? bounded.text : "";
    const bytes = Buffer.byteLength(content, "utf8");
    this.aggregateBytes += bytes;
    const incomplete = !payload.complete || bounded.truncated || remaining === 0;
    const finalStatus = status === "ok" && incomplete ? "exhausted" : status;
    const truncated = incomplete || status === "exhausted";
    const limitation = payload.limitation?.trim();
    const finalSummary = finalStatus === "exhausted"
      ? [limitation || summary || "Evidence collection was incomplete", bounded.truncated ? "result byte limit reached" : "", remaining === 0 ? "aggregate byte limit reached" : ""]
        .filter(Boolean).join("; ")
      : summary.slice(0, 500);
    const source = sourceDescriptor(request).slice(0, 500);
    const auditArguments = this.auditArguments(request);
    const evidenceId = `ev_${createHash("sha256")
      .update(JSON.stringify({ tool: request.tool, source, request: auditArguments, status: finalStatus, truncated, contentHash: createHash("sha256").update(content).digest("hex") }))
      .digest("hex")
      .slice(0, 16)}`;
    const result: AdvisorEvidenceToolResult = {
      evidenceId,
      tool: request.tool,
      source,
      status: finalStatus,
      summary: finalSummary.slice(0, 500),
      content,
      bytes,
      truncated,
    };
    this.options.audit?.({
      tool: request.tool,
      status: result.status,
      evidenceId,
      durationMs: Date.now() - startedAt,
      bytes,
      truncated,
      arguments: auditArguments,
      cwd: this.options.repoPath,
      scopeRoot: ADVISOR_FILESYSTEM_SCOPE_ROOT,
    });
    return result;
  }

  private auditArguments(request: AdvisorEvidenceToolRequest): Record<string, string | number | boolean> {
    switch (request.tool) {
      case "repo.list_files": return { pathSha256: descriptorHash(request.path ?? "."), depth: request.depth ?? 3 };
      case "repo.read_file": return { pathSha256: descriptorHash(request.path) };
      case "repo.search_text": return { pathSha256: descriptorHash(request.path ?? "."), querySha256: descriptorHash(request.query), queryChars: request.query.length };
      case "git.diff": return {
        scope: request.scope ?? "working",
        hasBase: Boolean(request.base),
        hasHead: Boolean(request.head),
        ...(request.base ? { baseSha256: descriptorHash(request.base) } : {}),
        ...(request.head ? { headSha256: descriptorHash(request.head) } : {}),
        ...(request.repoPath ? { repoPathSha256: descriptorHash(request.repoPath) } : {}),
      };
      case "git.show": return {
        objectSha256: descriptorHash(request.object),
        hasPath: Boolean(request.path),
        ...(request.path ? { pathSha256: descriptorHash(request.path) } : {}),
        ...(request.repoPath ? { repoPathSha256: descriptorHash(request.repoPath) } : {}),
      };
      case "git.log": return {
        count: request.count ?? 10,
        ...(request.repoPath ? { repoPathSha256: descriptorHash(request.repoPath) } : {}),
      };
      case "git.status": return {
        ...(request.repoPath ? { repoPathSha256: descriptorHash(request.repoPath) } : {}),
      };
      default: return {};
    }
  }

  private gitArgs(args: string[]): string[] {
    return [...GIT_READ_PREFIX, ...args];
  }

  private async perform(request: AdvisorEvidenceToolRequest, deadline: number): Promise<EvidencePayload> {
    switch (request.tool) {
      case "repo.list_files": {
        const collection = await this.collectFiles(request.path ?? ".", request.depth ?? 3, deadline);
        return {
          content: collection.files.join("\n"),
          complete: collection.complete,
          limitation: [...collection.limitations].join("; "),
        };
      }
      case "repo.read_file":
        return this.readText(request.path, deadline);
      case "repo.search_text":
        return this.searchText(request.path ?? ".", request.query, deadline);
      case "git.status":
        return this.runGit(this.gitArgs(["status", "--short", "--branch", "--untracked-files=normal"]), deadline, true, request.repoPath);
      case "git.diff":
        if (request.scope === "staged") return this.runGit(this.gitArgs(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3"]), deadline, true, request.repoPath);
        if (request.scope === "base_to_head") return this.runGit(this.gitArgs(["diff", "--no-ext-diff", "--no-textconv", "--unified=3", `${request.base}...${request.head}`]), deadline, true, request.repoPath);
        return this.runGit(this.gitArgs(["diff", "--no-ext-diff", "--no-textconv", "--unified=3"]), deadline, true, request.repoPath);
      case "git.show":
        return request.path
          ? this.runGit(this.gitArgs(["show", "--no-ext-diff", "--no-textconv", `${request.object}:${request.path}`]), deadline, false, request.repoPath)
          : this.runGit(this.gitArgs(["show", "--no-patch", "--format=medium", "--stat", request.object]), deadline, true, request.repoPath);
      case "git.log":
        return this.runGit(this.gitArgs(["log", `-${request.count ?? 10}`, "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s"]), deadline, false, request.repoPath);
      case "evidence.acceptance":
        return this.workerEvidence("acceptance");
      case "evidence.plan":
        return this.workerEvidence("plan");
      case "evidence.test_failures":
        return this.workerEvidence("testFailures");
      case "evidence.attempt_summary":
        return this.workerEvidence("attemptSummary");
    }
  }

  private workerEvidence(key: keyof AdvisorWorkerEvidence): EvidencePayload {
    const value = this.options.evidence?.[key];
    if (!value) throw new Error(`Advisor evidence unavailable: ${key}`);
    return { content: value, complete: true };
  }

  private async root(deadline: number): Promise<string> {
    return this.beforeDeadline(() => this.rootPromise, deadline);
  }

  /** Resolves an explicit absolute repoPath (Issue #229 Part 2), or falls back to the invoking cwd. */
  private async resolveRepoRoot(explicitRepoPath: string | undefined, deadline: number): Promise<string> {
    const candidate = explicitRepoPath ?? await this.root(deadline);
    return this.beforeDeadlineUnavailable("repoPath", () => realpath(candidate), deadline);
  }

  private async runGit(args: string[], deadline: number, filterSensitivePaths: boolean, explicitRepoPath?: string): Promise<EvidencePayload> {
    const root = await this.resolveRepoRoot(explicitRepoPath, deadline);
    const timeoutMs = Math.max(1, deadline - Date.now());
    let raw: string;
    if (this.options.runGit) {
      raw = String(await this.beforeDeadline(
        () => Promise.resolve(this.options.runGit!(args, root, { timeoutMs })),
        deadline,
      ));
    } else {
      const result = await this.beforeDeadline(
        () => execFileAsync("git", args, {
          cwd: root,
          encoding: "utf8",
          env: safeGitEnvironment(),
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: Math.max(256 * 1024, this.limits.maxAggregateBytes * 4),
        }),
        deadline,
      );
      raw = String(result.stdout ?? "");
    }
    return filterSensitivePaths
      ? sanitiseGitEvidence(raw)
      : { content: raw.trim(), complete: true };
  }

  // Issue #229 Part 2: filesystem scope is "/" — no repo-containment check.
  // Relative paths resolve against the invoking cwd; absolute paths are used
  // as-is. realpath() canonicalises the result and resolves symlinks in one
  // step; the sensitive-path filter is re-applied to the canonical target so
  // a symlink can't smuggle a secret file in under an innocuous name. Any
  // failure (missing, unreadable, symlink loop) is surfaced as a clear
  // "unavailable" result rather than silently falling back.
  private async resolveExisting(pathInput: string, deadline: number): Promise<string> {
    const cwd = await this.root(deadline);
    const normalizedPath = safePathInput(pathInput, "path", true);
    const candidate = isAbsolute(normalizedPath) ? normalizedPath : resolve(cwd, normalizedPath);
    const canonical = await this.beforeDeadlineUnavailable("path", () => realpath(candidate), deadline);
    if (hasSensitivePath(canonical)) throw new Error("path targets a sensitive path");
    return canonical;
  }

  private async readText(relativePath: string, deadline: number): Promise<EvidencePayload> {
    const path = await this.resolveExisting(relativePath, deadline);
    const handle = await this.beforeDeadlineUnavailable("path", () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW), deadline);
    try {
      const details = await this.beforeDeadline(() => handle.stat(), deadline);
      if (!details.isFile()) throw new Error("Advisor evidence path is not a file");
      const buffer = Buffer.alloc(this.limits.maxResultBytes + 1);
      const read = await this.beforeDeadline(() => handle.read(buffer, 0, buffer.length, 0), deadline);
      const content = buffer.subarray(0, read.bytesRead);
      if (content.includes(0)) throw new Error("Binary files are denied for advisor evidence");
      const text = content.toString("utf8");
      if (text.includes("�")) throw new Error("Binary or invalid UTF-8 files are denied for advisor evidence");
      const complete = details.size <= this.limits.maxResultBytes;
      return {
        content: text,
        complete,
        limitation: complete ? undefined : `file exceeds ${this.limits.maxResultBytes} byte read limit`,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async collectFiles(relativePath: string, requestedDepth: number, deadline: number): Promise<FileCollection> {
    const root = await this.root(deadline);
    const base = await this.resolveExisting(relativePath, deadline);
    const details = await this.beforeDeadlineUnavailable("path", () => stat(base), deadline);
    if (!details.isDirectory()) throw new Error("Advisor evidence path is not a directory");
    const maxDepth = Math.min(requestedDepth, this.limits.maxDepth);
    const files: string[] = [];
    const limitations = new Set<string>();
    let entriesVisited = 0;
    let complete = true;

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (!complete && (files.length >= this.limits.maxFiles || entriesVisited >= this.limits.maxEntries)) return;
      const entries = await this.beforeDeadline(
        () => readdir(dir, { withFileTypes: true }),
        deadline,
      );
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entriesVisited >= this.limits.maxEntries) {
          complete = false;
          limitations.add(`entry limit ${this.limits.maxEntries} reached`);
          return;
        }
        entriesVisited += 1;
        const absolute = resolve(dir, entry.name);
        const rel = relative(root, absolute).replaceAll("\\", "/");
        if (hasSensitivePath(rel)) continue;

        // Issue #229 Part 2: symlinks are resolved (not denied outright);
        // bounded depth/entry/file limits keep traversal safe through any
        // symlink cycle. A dirent's own isDirectory()/isFile() reflect the
        // link itself, not its target, so resolve the target's real type.
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          let resolved: string;
          try {
            resolved = await this.beforeDeadline(() => realpath(absolute), deadline);
          } catch {
            continue; // broken or unreadable symlink target — skip silently
          }
          if (hasSensitivePath(resolved)) continue;
          const targetStat = await this.beforeDeadline(() => stat(resolved), deadline).catch(() => null);
          if (!targetStat) continue;
          isDirectory = targetStat.isDirectory();
          isFile = targetStat.isFile();
        }

        if (isDirectory) {
          if (depth >= maxDepth) {
            complete = false;
            limitations.add(`depth limit ${maxDepth} reached`);
            continue;
          }
          const verifiedDirectory = await this.resolveExisting(rel, deadline);
          await visit(verifiedDirectory, depth + 1);
          if (files.length >= this.limits.maxFiles || entriesVisited >= this.limits.maxEntries) return;
        } else if (isFile) {
          if (files.length >= this.limits.maxFiles) {
            complete = false;
            limitations.add(`file limit ${this.limits.maxFiles} reached`);
            return;
          }
          files.push(rel);
        }
      }
    };

    await visit(base, 0);
    return { files, complete, limitations };
  }

  private async searchText(relativePath: string, query: string, deadline: number): Promise<EvidencePayload> {
    const collection = await this.collectFiles(relativePath, this.limits.maxDepth, deadline);
    const matches: string[] = [];
    let complete = collection.complete;
    const limitations = new Set(collection.limitations);

    for (const file of collection.files) {
      if (matches.length >= this.limits.maxMatches) {
        complete = false;
        limitations.add(`match limit ${this.limits.maxMatches} reached`);
        break;
      }
      let payload: EvidencePayload;
      try {
        payload = await this.readText(file, deadline);
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        if (/timeout|deadline/i.test(error.message)) throw error;
        complete = false;
        limitations.add("one or more files could not be inspected");
        continue;
      }
      if (!payload.complete) {
        complete = false;
        limitations.add("one or more files exceeded the per-file read limit");
      }
      const lines = payload.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].includes(query)) {
          matches.push(`${file}:${index + 1}: ${lines[index].slice(0, 500)}`);
          if (matches.length >= this.limits.maxMatches) {
            complete = false;
            limitations.add(`match limit ${this.limits.maxMatches} reached`);
            break;
          }
        }
      }
    }

    return {
      content: matches.length
        ? matches.join("\n")
        : complete ? "No literal matches found." : "No literal matches found in the scanned subset.",
      complete,
      limitation: [...limitations].join("; "),
    };
  }
}
