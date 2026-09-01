/**
 * PURPOSE: Bounded read-only runtime/capability projection for provider agents.
 * INPUTS: Existing Agent Bridge SQLite/evidence/Skill state and non-secret env.
 * OUTPUTS: Machine-readable JSON only; no execution or mutation authority.
 * NEIGHBORS: src/workspaceContext.ts, src/scheduledRoutines.ts, src/providers/qualification.ts
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBotsConfig } from "./config.js";
import { CURRENT_SCHEMA_VERSION } from "./db/schema.js";
import { parseCadenceSeconds } from "./health/config.js";
import { PROVIDER_CONTRACT_VERSION, qualificationEvidencePath, readQualificationEvidence } from "./providers/qualification.js";
import { getProviderAdapters } from "./providers/registry.js";
import { latestDueScheduledOccurrence, type ScheduledRoutine } from "./scheduledRoutines.js";
import { getSharedSkillsHomeDir, listLocalCatalog, resolveSkillPaths } from "./skills.js";

export const MAX_INSPECTION_OUTPUT_CHARS = 32_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HEALTH_DB_PATH = "/home/content-crawler/runtime/agent-bridge/health/health.sqlite";
const ROUTINE_PREFIX = "scheduled-routine:v1:";
const OCCURRENCE_PREFIX = "scheduled-routine-occurrence:v1:";
const HOUR_MS = 60 * 60 * 1_000;
const WEEKLY_PROJECTION_HORIZON_MS = 8 * 24 * HOUR_MS;
type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;
type ProviderId = "codex" | "claude" | "agy" | "grok" | "cursor";

const text = (value: unknown, max = 160): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const pid = (value: unknown): ProviderId | null => value === "antigravity" || value === "agy" ? "agy" : value === "codex" || value === "claude" || value === "grok" || value === "cursor" ? value : null;
const hasTable = (db: Database.Database, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const openRo = (path: string) => new Database(path, { readonly: true, fileMustExist: true });
const laneRef = (surface: string | null, chat: string) => createHash("sha256").update(`${surface ?? "unknown"}\0${chat}`).digest("hex").slice(0, 16);
const code = (value: unknown, fallback: string) => {
  const candidate = text(value, 80)?.toLowerCase();
  return candidate && /^[a-z0-9_.:-]+$/.test(candidate) ? candidate : fallback;
};

function projectRoot(env: Env): string {
  return env.BRIDGE_PROJECT_DIR?.trim() || ROOT;
}

function releaseManifestCommit(root: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Row;
    const commit = text(manifest.commit, 120);
    return commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function dbPath(env: Env): string {
  const explicit = env.AGENT_BRIDGE_CONTEXT_DB?.trim() || env.DB_PATH?.trim();
  if (explicit) return explicit;
  const root = projectRoot(env);
  const candidates = [join(root, ".data", "bridge.sqlite"), join(root, ".data", "discord-interactive.sqlite")].filter(existsSync);
  if (candidates.length === 1) return candidates[0];
  const runId = env.AGENT_BRIDGE_RUN_ID?.trim();
  if (runId) for (const candidate of candidates) {
    try {
      const db = openRo(candidate);
      try { if (hasTable(db, "bridge_runs") && db.prepare("SELECT 1 FROM bridge_runs WHERE run_id=?").get(runId)) return candidate; }
      finally { db.close(); }
    } catch {}
  }
  throw new Error("runtime database path is unavailable or ambiguous");
}

function scope(db: Database.Database, env: Env) {
  const runId = text(env.AGENT_BRIDGE_RUN_ID, 120);
  let chatKey = text(env.AGENT_BRIDGE_CHAT_KEY, 240);
  let surface = text(env.AGENT_BRIDGE_SURFACE_IDENTITY, 160);
  let provider: ProviderId | null = null;
  if (runId && hasTable(db, "bridge_runs")) {
    const run = db.prepare("SELECT chat_id,bot FROM bridge_runs WHERE run_id=? AND status='running'").get(runId) as Row | undefined;
    chatKey ||= text(run?.chat_id, 240);
    provider = pid(run?.bot);
  }
  if (runId && hasTable(db, "execution_locks")) {
    const lock = db.prepare("SELECT surface,chat_key FROM execution_locks WHERE run_id=? ORDER BY acquired_at DESC LIMIT 1").get(runId) as Row | undefined;
    surface ||= text(lock?.surface);
    chatKey ||= text(lock?.chat_key, 240);
  }
  return { runId, chatKey, surface, provider };
}

function runReason(db: Database.Database, runId: string, status: string) {
  if (!hasTable(db, "bridge_events")) return { reasonCode: `${status}:unclassified`, reconciled: false };
  const row = db.prepare("SELECT type,payload_json FROM bridge_events WHERE run_id=? AND type IN ('run.reconciled','run.failed','run.cancelled') ORDER BY seq DESC LIMIT 1").get(runId) as Row | undefined;
  if (!row) return { reasonCode: `${status}:unclassified`, reconciled: false };
  let payload: Row = {};
  try { payload = JSON.parse(String(row.payload_json ?? "{}")) as Row; } catch {}
  if (row.type === "run.reconciled") return { reasonCode: `reconciled:${code(payload.reason, "unclassified")}`, reconciled: true };
  if (row.type === "run.cancelled") return { reasonCode: `cancelled:${code(payload.reason, "unclassified")}`, reconciled: false };
  return { reasonCode: `failed:${code(payload.category, "unclassified")}`, reconciled: false };
}

function execution(db: Database.Database, s: ReturnType<typeof scope>) {
  if (!hasTable(db, "bridge_runs")) return { status: "unavailable", reasonCode: "run_store_unavailable", currentRunId: s.runId, activeRuns: [], recentTerminal: [], locks: [] };
  const active = db.prepare("SELECT run_id,chat_id,bot,started_at FROM bridge_runs WHERE status='running' ORDER BY started_at DESC LIMIT 12").all() as Row[];
  const terminal = db.prepare("SELECT run_id,chat_id,bot,status,started_at,ended_at FROM bridge_runs WHERE status IN ('failed','cancelled') ORDER BY ended_at DESC LIMIT 12").all() as Row[];
  const lockRows = hasTable(db, "execution_locks") ? db.prepare("SELECT surface,chat_key,run_id,acquired_at,lease_expires_at FROM execution_locks ORDER BY acquired_at DESC LIMIT 16").all() as Row[] : [];
  const surfaceFor = (runId: string) => text((lockRows.find((row) => row.run_id === runId))?.surface) ?? (runId === s.runId ? s.surface : null);
  const currentActive = !s.runId || active.some((row) => row.run_id === s.runId);
  return {
    status: currentActive ? "ready" : "unknown",
    reasonCode: currentActive ? null : "current_run_not_active",
    currentRunId: s.runId,
    activeRuns: active.map((row) => ({ runId: String(row.run_id), provider: pid(row.bot), status: "running", startedAt: text(row.started_at, 40), surface: surfaceFor(String(row.run_id)), conversationRef: laneRef(surfaceFor(String(row.run_id)), String(row.chat_id)), current: row.run_id === s.runId })),
    recentTerminal: terminal.map((row) => ({ runId: String(row.run_id), provider: pid(row.bot), status: row.status, startedAt: text(row.started_at, 40), endedAt: text(row.ended_at, 40), surface: surfaceFor(String(row.run_id)), conversationRef: laneRef(surfaceFor(String(row.run_id)), String(row.chat_id)), ...runReason(db, String(row.run_id), String(row.status)) })),
    locks: lockRows.map((row) => ({ runId: text(row.run_id, 120), surface: text(row.surface), laneRef: laneRef(text(row.surface), String(row.chat_key)), acquiredAt: text(row.acquired_at, 40), leaseExpiresAt: text(row.lease_expires_at, 40), state: Date.parse(String(row.lease_expires_at)) > Date.now() ? "active" : "expired" })),
  };
}

function sessions(db: Database.Database, s: ReturnType<typeof scope>) {
  if (!s.chatKey) return { status: "unknown", reasonCode: "conversation_scope_unavailable", providers: [] };
  if (!hasTable(db, "bridge_state")) return { status: "unavailable", reasonCode: "session_store_unavailable", providers: [] };
  const row = db.prepare("SELECT * FROM bridge_state WHERE chat_id=?").get(s.chatKey) as Row | undefined;
  const fields: Array<[ProviderId,string]> = [["codex","codex"],["claude","claude"],["agy","antigravity"],["grok","grok"],["cursor","cursor"]];
  return { status: "ready", reasonCode: null, providers: fields.map(([provider,key]) => ({ provider, exists: Boolean(row?.[`${key}_session_id`]), createdAt: text(row?.[`${key}_session_created_at`], 40) })) };
}

function nextRoutineOccurrence(routine: Row) {
  if (routine.enabled !== true) return { nextIntendedAt: null, nextIntendedReasonCode: "routine_disabled" };
  const projected = routine as unknown as ScheduledRoutine;
  const nowMs = Date.now();
  try {
    if (projected.schedule?.type === "once") {
      const roughMs = Date.parse(`${projected.schedule.localDateTime}:00Z`);
      if (!Number.isFinite(roughMs)) return { nextIntendedAt: null, nextIntendedReasonCode: "schedule_projection_unavailable" };
      const occurrence = latestDueScheduledOccurrence(projected, Math.max(nowMs, roughMs + 36 * HOUR_MS), Number.MAX_SAFE_INTEGER);
      if (occurrence && Date.parse(occurrence.intendedAt) > nowMs) return { nextIntendedAt: occurrence.intendedAt, nextIntendedReasonCode: null };
      return { nextIntendedAt: null, nextIntendedReasonCode: "no_future_occurrence" };
    }
    if (projected.schedule?.type === "weekly") {
      for (let probeMs = nowMs; probeMs <= nowMs + WEEKLY_PROJECTION_HORIZON_MS; probeMs += HOUR_MS) {
        const occurrence = latestDueScheduledOccurrence(projected, probeMs, Number.MAX_SAFE_INTEGER);
        if (occurrence && Date.parse(occurrence.intendedAt) > nowMs) return { nextIntendedAt: occurrence.intendedAt, nextIntendedReasonCode: null };
      }
      return { nextIntendedAt: null, nextIntendedReasonCode: "no_future_occurrence" };
    }
  } catch {}
  return { nextIntendedAt: null, nextIntendedReasonCode: "schedule_projection_unavailable" };
}

function routines(db: Database.Database, s: ReturnType<typeof scope>, env: Env) {
  if (!s.chatKey || !s.surface || !hasTable(db, "settings")) return [];
  const owner = text(env.AGENT_BRIDGE_OWNER_KEY, 240);
  const rows = db.prepare("SELECT value FROM settings WHERE key LIKE ? ORDER BY key LIMIT 48").all(`${ROUTINE_PREFIX}%`) as Row[];
  const out: Row[] = [];
  for (const row of rows) {
    if (out.length >= 12) break;
    let r: Row;
    try { r = JSON.parse(String(row.value)) as Row; } catch { continue; }
    if (r.surfaceIdentity !== s.surface || r.chatKey !== s.chatKey || (owner && r.ownerKey !== owner)) continue;
    const id = text(r.id, 100);
    if (!id) continue;
    const occurrencePrefix = `${OCCURRENCE_PREFIX}${id}:`;
    const occurrence = db.prepare("SELECT key,value FROM settings WHERE key LIKE ? ORDER BY key DESC LIMIT 1").get(`${occurrencePrefix}%`) as Row | undefined;
    const claimedAt = text(occurrence?.value, 60);
    let correlatedRun: Row | null = null;
    let correlationReasonCode: string | null = occurrence ? "run_correlation_unavailable" : null;
    if (claimedAt && hasTable(db, "bridge_runs")) {
      const claimedMs = Date.parse(claimedAt);
      if (Number.isFinite(claimedMs)) {
        const cutoff = new Date(claimedMs + 30_000).toISOString();
        const candidates = db.prepare(`SELECT run_id,status,bot,started_at FROM bridge_runs
          WHERE chat_id=? AND started_at>=? AND started_at<=?
          ORDER BY started_at ASC, rowid ASC LIMIT 2`).all(s.chatKey, claimedAt, cutoff) as Row[];
        if (candidates.length === 1) {
          correlatedRun = candidates[0];
          correlationReasonCode = null;
        } else if (candidates.length > 1) {
          correlationReasonCode = "run_correlation_ambiguous";
        }
      }
    }
    const schedule = r.schedule && typeof r.schedule === "object" ? r.schedule as Row : null;
    const next = nextRoutineOccurrence(r);
    out.push({ id, name: text(r.name, 120), kind: r.kind === "autonomous" ? "autonomous" : "companion", enabled: r.enabled === true, schedule: schedule?.type === "once" ? { type: "once", localDateTime: text(schedule.localDateTime, 40) } : schedule?.type === "weekly" ? { type: "weekly", weekdays: Array.isArray(schedule.weekdays) ? schedule.weekdays.slice(0,7) : [], time: text(schedule.time, 20) } : null, timezone: text(r.timezone, 100), ...next, recentOccurrence: occurrence ? { intendedAt: text(String(occurrence.key).slice(occurrencePrefix.length), 60), claimedAt, runId: text(correlatedRun?.run_id, 120), runStatus: text(correlatedRun?.status, 40), provider: pid(correlatedRun?.bot), reasonCode: correlationReasonCode } : null });
  }
  return out;
}

function withOptionalDb<T>(path: string | null, mainPath: string, main: Database.Database, unavailable: T, read: (db: Database.Database) => T): T {
  if (!path || path === mainPath) return read(main);
  if (!existsSync(path)) return unavailable;
  try {
    const db = openRo(path);
    try { return read(db); } finally { db.close(); }
  } catch { return unavailable; }
}

function autonomy(main: Database.Database, mainPath: string, env: Env) {
  return withOptionalDb(text(env.AGENT_BRIDGE_AUTONOMY_DB_PATH, 500), mainPath, main, { status: "unknown", reasonCode: "autonomy_db_unavailable", goals: [] as Row[] }, (db) => {
    if (!hasTable(db, "autonomous_goals")) return { status: "unavailable", reasonCode: "autonomy_store_unavailable", goals: [] as Row[] };
    const goals = db.prepare("SELECT goal_id,bot,max_cycles,cycle,status FROM autonomous_goals ORDER BY rowid DESC LIMIT 8").all() as Row[];
    const receipts = hasTable(db, "event_receipts") ? db.prepare("SELECT id,status,occurred_at,run_id,payload_json FROM event_receipts WHERE source='autonomous' AND event_kind='goal_wake' AND status IN ('received','run_created') ORDER BY id LIMIT 32").all() as Row[] : [];
    return { status: "ready", reasonCode: null, goals: goals.map((goal) => {
      const goalId = String(goal.goal_id);
      const wake = receipts.find((item) => { try { return (JSON.parse(String(item.payload_json ?? "{}")) as Row).goalId === goalId; } catch { return false; } });
      let wakeReason: string | null = null;
      if (wake) try { wakeReason = code((JSON.parse(String(wake.payload_json ?? "{}")) as Row).reason, "unclassified"); } catch {}
      return { goalId: text(goalId, 120), provider: pid(goal.bot), status: text(goal.status, 40), cycle: Number(goal.cycle)||0, maxCycles: Number(goal.max_cycles)||0, nextWake: wake ? { receiptId: Number(wake.id), status: text(wake.status,40), occurredAt: text(wake.occurred_at,60), runId: text(wake.run_id,120), reasonCode: wakeReason } : null };
    }) };
  });
}

function health(main: Database.Database, mainPath: string, env: Env) {
  const freshnessSeconds = parseCadenceSeconds(env) * 2;
  if (env.HEALTH_MONITOR_ENABLED !== "true") return { enabled: false, status: null, reasonCode: "health_monitor_disabled", freshnessSeconds, nonGreen: [] as Row[], stalePluginNames: [] as string[], missingPluginNames: [] as string[] };
  const explicitHealthPath = text(env.HEALTH_DB_PATH, 500);
  const healthPath = explicitHealthPath ?? (existsSync(DEFAULT_HEALTH_DB_PATH) ? DEFAULT_HEALTH_DB_PATH : mainPath);
  return withOptionalDb(healthPath, mainPath, main, { enabled: true, status: null, reasonCode: "health_db_unavailable", freshnessSeconds, nonGreen: [] as Row[], stalePluginNames: [] as string[], missingPluginNames: [] as string[] }, (db) => {
    if (!hasTable(db, "health_plugin_reports")) return { enabled: true, status: null, reasonCode: "health_store_unavailable", freshnessSeconds, nonGreen: [] as Row[], stalePluginNames: [] as string[], missingPluginNames: [] as string[] };
    const names = ["self", ...(env.HEALTH_SERVER_MONITOR_ENABLED === "0" ? [] : ["server"]), ...(env.HEALTH_CONTENT_CRAWLER_ENABLED === "1" ? ["content-crawler"] : [])];
    const rows = db.prepare(`SELECT plugin_name,report_json,saved_at FROM health_plugin_reports WHERE plugin_name IN (${names.map(()=>"?").join(",")})`).all(...names) as Row[];
    const byName = new Map(rows.map((row) => [String(row.plugin_name), row]));
    const stale: string[] = [];
    const missing: string[] = [];
    const fresh: Array<{pluginName:string;status:"green"|"amber"|"red";savedAt:string}> = [];
    const now = Math.floor(Date.now()/1000);
    for (const name of names) {
      const row = byName.get(name);
      if (!row) { missing.push(name); continue; }
      const saved = Number(row.saved_at);
      if (!Number.isFinite(saved) || now-saved>freshnessSeconds) { stale.push(name); continue; }
      try {
        const report = JSON.parse(String(row.report_json)) as Row;
        if (report.status!=="green"&&report.status!=="amber"&&report.status!=="red") { missing.push(name); continue; }
        fresh.push({pluginName:name,status:report.status,savedAt:new Date(saved*1000).toISOString()});
      } catch { missing.push(name); }
    }
    const status = fresh.some((x)=>x.status==="red") ? "red" : fresh.some((x)=>x.status==="amber") ? "amber" : fresh.length ? "green" : null;
    return { enabled: true, status, reasonCode: status ? null : stale.length ? "health_evidence_stale" : "health_evidence_missing", freshnessSeconds, nonGreen: fresh.filter((x)=>x.status!=="green"), stalePluginNames: stale, missingPluginNames: missing };
  });
}

function providers(s: ReturnType<typeof scope>, env: Env, commit: string | null) {
  const bots = loadBotsConfig(env);
  const path = env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH?.trim() || qualificationEvidencePath(env.HOME?.trim() || homedir());
  let evidence: ReturnType<typeof readQualificationEvidence> | null = null;
  let evidenceReason: string | null = null;
  try { evidence = readQualificationEvidence(path); } catch { evidenceReason = "qualification_evidence_unreadable"; }
  return getProviderAdapters().map((adapter) => {
    const record = evidence?.providers[adapter.id];
    const key = (adapter.id === "agy" ? "antigravity" : adapter.id) as keyof typeof bots;
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      selected: s.provider === adapter.id,
      availability: s.provider === adapter.id ? "available" : "unknown",
      availabilityReasonCode: s.provider === adapter.id ? null : "not_live_probed",
      authentication: "unknown",
      defaultModel: bots[key].modelPreference[0] ?? null,
      qualification: !record
        ? { status: "unknown", reasonCode: evidenceReason ?? "no_qualification_evidence" }
        : record.contractVersion !== PROVIDER_CONTRACT_VERSION
          ? { status: "unqualified", reasonCode: "provider_contract_changed", lastResult: record.overall, providerVersion: text(record.providerVersion,80), contractVersion: record.contractVersion, qualifiedAt: text(record.qualifiedAt,60) }
          : { status: "unknown", reasonCode: "runtime_version_unobserved", lastResult: record.overall, providerVersion: text(record.providerVersion,80), contractVersion: record.contractVersion, qualifiedAt: text(record.qualifiedAt,60), bridgeCommitMatches: Boolean(commit && record.bridgeCommit===commit) },
    };
  });
}

function skills(env: Env) {
  const home = getSharedSkillsHomeDir({HOME:env.HOME,SHARED_MEMORY_HOME:env.SHARED_MEMORY_HOME}, homedir());
  const paths = resolveSkillPaths(home);
  let installed: string[] = [];
  let installedStatus: "ready"|"unknown"|"unavailable" = "unavailable";
  let installedReasonCode: string|null = "skill_index_missing";
  if (existsSync(paths.lockfilePath)) try {
    const value = JSON.parse(readFileSync(paths.lockfilePath,"utf8")) as {skills?:Record<string,unknown>};
    installed = Object.keys(value.skills??{}).sort().slice(0,24);
    installedStatus="ready";
    installedReasonCode=null;
  } catch {
    installedStatus="unknown";
    installedReasonCode="skill_index_unreadable";
  }
  let bundled: string[] = [];
  try { bundled = listLocalCatalog(projectRoot(env)).map((x)=>x.name).slice(0,24); } catch {}
  return { installedStatus, installedReasonCode, installed, bundled, root: paths.agentsSkillsDir };
}

function runtimeCommand(env: Env, name: string, configured?: string): string {
  const requested = configured?.trim();
  if (requested) return requested;
  return join(projectRoot(env), "bin", name);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function capabilityIndex(s: ReturnType<typeof scope>, env: Env, h: ReturnType<typeof health>, sk: ReturnType<typeof skills>, a: ReturnType<typeof autonomy>, ps: ReturnType<typeof providers>) {
  const inspect = runtimeCommand(env, "agent-bridge-inspect");
  const context = runtimeCommand(env, "agent-bridge-context");
  const routine = runtimeCommand(env, "agent-bridge-routines", env.AGENT_BRIDGE_ROUTINES_COMMAND);
  const routineExecutable = isExecutable(routine);
  const scoped=Boolean(s.chatKey&&s.surface);
  const cap=(id:string,status:string,reasonCode:string|null,scope:string,risk:string,authorityRequired:string,iface:string)=>({id,owner:"agent-bridge",status,reasonCode,scope,risk,authorityRequired,interface:iface});
  return [
    cap("runtime-inspection","ready",null,"runtime","read-only","none",`${inspect} --json`),
    cap("retained-context",scoped?"ready":"unavailable",scoped?null:"conversation_scope_unavailable","conversation","read-only","current conversation or proved owner",context),
    cap("advisor",env.AGENT_BRIDGE_ADVISOR_COMMAND&&env.AGENT_BRIDGE_ADVISOR_CAPABILITY?"ready":"unavailable",env.AGENT_BRIDGE_ADVISOR_COMMAND&&env.AGENT_BRIDGE_ADVISOR_CAPABILITY?null:"turn_capability_unavailable","turn","read-only-advice","turn capability",env.AGENT_BRIDGE_ADVISOR_COMMAND?.trim()||"agent-bridge-advisor"),
    cap("scheduled-routines",scoped&&routineExecutable?"ready":"unavailable",!scoped?"conversation_scope_unavailable":routineExecutable?null:"routine_command_unavailable","conversation","state-change","authenticated owner",routine),
    cap("autonomous-work",s.surface==="telegram:interactive"&&a.status==="ready"?"ready":"unavailable",s.surface!=="telegram:interactive"?"surface_not_supported":a.status==="ready"?null:a.reasonCode,"goal","execution","authenticated owner","first-class autonomy"),
    cap("health-investigation",h.enabled?"ready":"unavailable",h.enabled?null:"health_monitor_disabled","runtime","read-only","none","runtime inspector health projection"),
    cap("installed-skills",sk.installedStatus,sk.installedReasonCode,"runtime","read-only","none",sk.root),
    cap("chat-surfaces","ready",null,"runtime","read-only","none","telegram,discord"),
    cap("provider-execution",ps.some((p)=>p.selected)?"ready":"unknown",ps.some((p)=>p.selected)?null:"no_current_run_context","run","execution","existing bridge authority","native provider CLI"),
  ];
}

export function buildAgentBridgeInspection(env: Env = process.env) {
  const mainPath = dbPath(env);
  const db = openRo(mainPath);
  try {
    const schema = Number(db.pragma("user_version",{simple:true}));
    const s=scope(db,env);
    const commit=releaseManifestCommit(projectRoot(env)) ?? text(env.AGENT_BRIDGE_COMMIT??env.BRIDGE_COMMIT??env.BRIDGE_RELEASE_COMMIT,120);
    const ex=execution(db,s);
    const ss=sessions(db,s);
    const rs=routines(db,s,env);
    const a=autonomy(db,mainPath,env);
    const h=health(db,mainPath,env);
    const sk=skills(env);
    const ps=providers(s,env,commit);
    const caps=capabilityIndex(s,env,h,sk,a,ps);
    let version: string|null=null;
    try { version=text((JSON.parse(readFileSync(join(projectRoot(env),"package.json"),"utf8")) as Row).version,40); } catch {}
    const currentSurface=s.surface?.startsWith("telegram:")?"telegram":s.surface?.startsWith("discord:")?"discord":null;
    const serviceStatus = !s.runId ? { status: "unknown", reasonCode: "no_current_run_context" } : ex.activeRuns.some((r)=>r.runId===s.runId) ? { status: "ready", reasonCode: null } : { status: "unknown", reasonCode: "current_run_not_active" };
    return {
      schemaVersion:1,
      generatedAt:new Date().toISOString(),
      runtime:{
        packageVersion:version,
        commit,
        service:serviceStatus,
        database:{status:schema===CURRENT_SCHEMA_VERSION?"ready":"unavailable",schemaVersion:schema,expectedSchemaVersion:CURRENT_SCHEMA_VERSION},
        degradations:[schema===CURRENT_SCHEMA_VERSION?null:"database_schema_mismatch",h.status==="red"?"health_red":h.status==="amber"?"health_amber":null,sk.installedStatus==="unknown"?"skill_index_unreadable":null].filter(Boolean),
      },
      providers:ps,
      execution:ex,
      sessions:ss,
      scheduledRoutines:rs,
      autonomy:a,
      surfaces:["telegram","discord"].map((id)=>({id,status:currentSurface===id?"ready":"unknown",reasonCode:currentSurface===id?null:"not_current_surface",current:currentSurface===id})),
      health:h,
      knowledge:{
        skills:{installedStatus:sk.installedStatus,installedReasonCode:sk.installedReasonCode,installed:sk.installed,bundled:sk.bundled},
        retainedContext:{interface:runtimeCommand(env,"agent-bridge-context"),scopeKnown:Boolean(s.chatKey&&s.surface)},
        scheduledRoutines:{interface:runtimeCommand(env,"agent-bridge-routines",env.AGENT_BRIDGE_ROUTINES_COMMAND)},
        advisor:{availableForTurn:Boolean(env.AGENT_BRIDGE_ADVISOR_COMMAND&&env.AGENT_BRIDGE_ADVISOR_CAPABILITY)},
        supportedProviders:getProviderAdapters().map((x)=>x.id),
        supportedChatSurfaces:["telegram","discord"],
      },
      capabilities:caps,
    };
  } finally { db.close(); }
}

export function renderAgentBridgeInspection(args: string[], env: Env = process.env): string {
  if (!args.includes("--json")) throw new Error("usage: agent-bridge-inspect [capabilities] --json");
  const full=buildAgentBridgeInspection(env);
  const view=args[0]==="capabilities"?{schemaVersion:full.schemaVersion,generatedAt:full.generatedAt,runtime:{packageVersion:full.runtime.packageVersion,commit:full.runtime.commit},capabilities:full.capabilities}:full;
  const out=JSON.stringify(view);
  if(out.length>MAX_INSPECTION_OUTPUT_CHARS) throw new Error(`runtime inspector output exceeded ${MAX_INSPECTION_OUTPUT_CHARS} characters`);
  return out;
}
