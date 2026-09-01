from pathlib import Path

source = Path("src/runtimeInspector.ts")
text = source.read_text()
old = '''    const occurrence = db.prepare("SELECT key,value FROM settings WHERE key LIKE ? ORDER BY key DESC LIMIT 1").get(`${occurrencePrefix}%`) as Row | undefined;
    const schedule = r.schedule && typeof r.schedule === "object" ? r.schedule as Row : null;
    const next = nextRoutineOccurrence(r);
    out.push({ id, name: text(r.name, 120), kind: r.kind === "autonomous" ? "autonomous" : "companion", enabled: r.enabled === true, schedule: schedule?.type === "once" ? { type: "once", localDateTime: text(schedule.localDateTime, 40) } : schedule?.type === "weekly" ? { type: "weekly", weekdays: Array.isArray(schedule.weekdays) ? schedule.weekdays.slice(0,7) : [], time: text(schedule.time, 20) } : null, timezone: text(r.timezone, 100), ...next, recentOccurrence: occurrence ? { intendedAt: text(String(occurrence.key).slice(occurrencePrefix.length), 60), claimedAt: text(occurrence.value, 60), runId: null, reasonCode: "run_correlation_unavailable" } : null });
'''
new = '''    const occurrence = db.prepare("SELECT key,value FROM settings WHERE key LIKE ? ORDER BY key DESC LIMIT 1").get(`${occurrencePrefix}%`) as Row | undefined;
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
'''
if old not in text:
    raise SystemExit("routine projection block not found")
source.write_text(text.replace(old, new, 1))

test = Path("test/runtimeInspector.test.ts")
t = test.read_text()
t = t.replace(
    'import { createScheduledRoutine } from "../src/scheduledRoutines.js";',
    'import { claimScheduledRoutineOccurrence, createScheduledRoutine } from "../src/scheduledRoutines.js";',
    1,
)
old_create = '''      createScheduledRoutine(db, {
        id: "routine-1",
        name: "Daily status",
        instruction: "private routine instruction ghp_supersecret",
        kind: "companion",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-1",
        ownerKey: "owner-1",
        timezone: "UTC",
        schedule: { type: "weekly", weekdays: [1], time: "09:00" },
        enabled: true,
        createdAt: new Date().toISOString(),
      });
'''
new_create = old_create + '''      const routineOccurrence = new Date().toISOString();
      expect(claimScheduledRoutineOccurrence(db, "routine-1", routineOccurrence)).toBe(true);
      db.insertRun("run-routine", "chat-1", "codex");
'''
if old_create not in t:
    raise SystemExit("routine fixture block not found")
t = t.replace(old_create, new_create, 1)
old_assert = '''      expect(view.scheduledRoutines).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "routine-1", name: "Daily status", kind: "companion" }),
      ]));
'''
new_assert = '''      expect(view.scheduledRoutines).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "routine-1",
          name: "Daily status",
          kind: "companion",
          recentOccurrence: expect.objectContaining({
            runId: "run-routine",
            runStatus: "running",
            provider: "codex",
            reasonCode: null,
          }),
        }),
      ]));
'''
if old_assert not in t:
    raise SystemExit("routine assertion block not found")
t = t.replace(old_assert, new_assert, 1)
marker = '  it("uses unknown/unavailable states instead of inventing missing or stale evidence", () => {'
addition = r'''  it("fails closed when more than one Run could match a scheduled occurrence", () => {
    const { dir, path, db, healthDb } = fixture();
    try {
      createScheduledRoutine(db, {
        id: "routine-ambiguous",
        name: "Ambiguous routine",
        instruction: "bounded instruction",
        kind: "companion",
        surfaceIdentity: "telegram:interactive",
        chatKey: "chat-ambiguous",
        ownerKey: "owner-1",
        timezone: "UTC",
        schedule: { type: "weekly", weekdays: [1], time: "09:00" },
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      const intendedAt = new Date().toISOString();
      expect(claimScheduledRoutineOccurrence(db, "routine-ambiguous", intendedAt)).toBe(true);
      db.insertRun("run-a", "chat-ambiguous", "codex");
      db.insertRun("run-b", "chat-ambiguous", "claude");

      const view = JSON.parse(renderAgentBridgeInspection(["--json"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat-ambiguous",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_OWNER_KEY: "owner-1",
        HOME: dir,
      }));
      expect(view.scheduledRoutines[0].recentOccurrence).toEqual(expect.objectContaining({
        runId: null,
        reasonCode: "run_correlation_ambiguous",
      }));
    } finally {
      db.close();
      healthDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

'''
if marker not in t:
    raise SystemExit("ambiguity test insertion marker not found")
test.write_text(t.replace(marker, addition + marker, 1))
