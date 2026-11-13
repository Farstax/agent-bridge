import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  IDLE_UPGRADE_FENCE_KEY, readIdleUpgradeState, recoverIdleUpgrade,
  releaseIdleUpgrade, tryAdmitIdleUpgrade,
  readIdleUpgradeRolesState, releaseIdleUpgradeRoles, tryAdmitIdleUpgradeRoles, recoverIdleUpgradeRoles,
} from "../src/idleUpgradeAdmission.js";

let dir: string;
let path: string;
let db: BridgeDb;
const identity = { surfaceIdentity: "acp:outward", chatKey: "isolated" };
const event = {
  event_id: "e", source: "health", event_kind: "red", idempotency_key: "health:e",
  received_at: "2026-01-01T00:00:00.000Z", occurred_at: "2026-01-01T00:00:00.000Z",
  payload_json: "{}", authority_scope: "health",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-idle-fence-"));
  path = join(dir, "interactive.sqlite");
  db = openDb(path);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function admit() {
  const result = tryAdmitIdleUpgrade(path);
  expect(result.state).toBe("admitted");
  if (result.state !== "admitted") throw new Error("test fixture was not idle");
  return result.fence;
}

describe("atomic generic idle-only upgrade admission (#1161)", () => {
  it("serializes the idle check with older Run, queue, capacity and receipt writers", () => {
    expect(readIdleUpgradeState(path)).toBe("idle");
    const fence = admit();
    expect(readIdleUpgradeState(path)).toBe("deferred_busy");
    expect(tryAdmitIdleUpgrade(path)).toEqual({ state: "deferred_busy" });
    expect(() => db.insertRun("run", identity, "claude")).toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(() => db.acquireLock(identity.surfaceIdentity, identity.chatKey)).toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(() => db.enqueueMsg(identity.surfaceIdentity, identity.chatKey, {
      prompt: "queued", chatId: "isolated", chatType: "acp",
    })).toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(() => db.createEventReceipt(event)).toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(() => db.acquireExecutionCapacity(2, "execution", "acq")).toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(() => db.setSetting("run-continuation:v1:future", JSON.stringify({ state: "pending" })))
      .toThrow("agent_bridge_idle_maintenance_deferred_busy");
    db.setSetting("safe-configuration", "unchanged");
    expect(db.getSetting("safe-configuration")).toBe("unchanged");
    expect(releaseIdleUpgrade(path, "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(readIdleUpgradeState(path)).toBe("deferred_busy");
    expect(releaseIdleUpgrade(path, fence.token)).toBe(true);
    expect(readIdleUpgradeState(path)).toBe("idle");
    expect(db.acquireLock(identity.surfaceIdentity, identity.chatKey)).not.toBeNull();
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ab_idle_maintenance_%'").all()).toEqual([]);
  });

  it("does not mistake a concurrent SQLite writer for idle admission", () => {
    // A writer holding SQLite's reserved write lock has not yet committed its
    // Run. Admission must not read a stale idle snapshot and grant a fence.
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      db.insertRun("uncommitted-run", identity, "claude");
      expect(tryAdmitIdleUpgrade(path).state).toBe("unknown");
      expect(db.getSetting(IDLE_UPGRADE_FENCE_KEY)).toBeNull();
    } finally {
      db.raw.exec("COMMIT");
    }
    expect(tryAdmitIdleUpgrade(path)).toEqual({ state: "deferred_busy" });
    db.updateRunCompleted("uncommitted-run", "done", null);
    const fence = admit();
    expect(releaseIdleUpgrade(path, fence.token)).toBe(true);
  });

  it("defers while active Runs or locks are present, without installing triggers", () => {
    db.insertRun("active", identity, "claude");
    expect(tryAdmitIdleUpgrade(path).state).toBe("deferred_busy");
    expect(db.getSetting(IDLE_UPGRADE_FENCE_KEY)).toBeNull();
    db.updateRunCompleted("active", "done", null);
    const lock = db.acquireLock(identity.surfaceIdentity, identity.chatKey)!;
    expect(tryAdmitIdleUpgrade(path).state).toBe("deferred_busy");
    db.unlock(lock);
    expect(tryAdmitIdleUpgrade(path).state).toBe("admitted");
  });

  it("preserves durable queued messages across idle admission without allowing them to execute", () => {
    const id = db.enqueueMsg(identity.surfaceIdentity, identity.chatKey, {
      prompt: "pending", chatId: "isolated", chatType: "acp",
    });
    expect(readIdleUpgradeState(path)).toBe("idle");
    const fence = admit();
    expect(() => db.raw.prepare("UPDATE pending_messages SET state = 'claimed' WHERE id = ?").run(id))
      .toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(db.raw.prepare("SELECT state, prompt FROM pending_messages WHERE id = ?").get(id))
      .toMatchObject({ state: "queued", prompt: "pending" });
    expect(releaseIdleUpgrade(path, fence.token)).toBe(true);
    expect(db.raw.prepare("SELECT state, prompt FROM pending_messages WHERE id = ?").get(id))
      .toMatchObject({ state: "queued", prompt: "pending" });
  });

  it("permits persisted undelivered receipts but fences dispatch, and defers actual claims", () => {
    db.createEventReceipt(event);
    expect(readIdleUpgradeState(path)).toBe("idle");
    const fence = admit();
    expect(() => db.raw.prepare("UPDATE event_receipts SET status = 'dispatching' WHERE idempotency_key = ?")
      .run(event.idempotency_key)).toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(releaseIdleUpgrade(path, fence.token)).toBe(true);
    db.raw.prepare("DELETE FROM event_receipts WHERE idempotency_key = ?").run(event.idempotency_key);
    const id = db.enqueueMsg(identity.surfaceIdentity, identity.chatKey, {
      prompt: "claimed", chatId: "isolated", chatType: "acp",
    });
    db.raw.prepare("UPDATE pending_messages SET state = 'claimed' WHERE id = ?").run(id);
    expect(tryAdmitIdleUpgrade(path).state).toBe("deferred_busy");
    db.deletePendingMsg(id);
    const key = "run-continuation:v1:delayed";
    const pending = JSON.stringify({ version: 1, state: "pending" });
    db.setSetting(key, pending);
    expect(readIdleUpgradeState(path)).toBe("idle");
    const fence = admit();
    expect(db.getSetting(key)).toBe(pending);
    expect(() => db.setSetting(key, JSON.stringify({ version: 1, state: "claimed" })))
      .toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(() => db.insertRun("continuation-wake", identity, "claude"))
      .toThrow("agent_bridge_idle_maintenance_deferred_busy");
    expect(db.getSetting(key)).toBe(pending);
    expect(releaseIdleUpgrade(path, fence.token)).toBe(true);
    db.setSetting(key, JSON.stringify({ version: 1, state: "claimed" }));
    expect(tryAdmitIdleUpgrade(path)).toEqual({ state: "deferred_busy" });
    db.setSetting(key, JSON.stringify({ version: 1, state: "completed" }));
    const recovered = admit();
    expect(releaseIdleUpgrade(path, recovered.token)).toBe(true);
  });

  it("admits all database roles with a dormant wake but fences a racing claim", () => {
    const workerPath = join(dir, "worker.sqlite");
    const worker = openDb(workerPath);
    try {
      const key = "run-continuation:v1:future";
      const pending = JSON.stringify({ version: 1, state: "pending" });
      db.setSetting(key, pending);
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("idle");
      const admitted = tryAdmitIdleUpgradeRoles([path, workerPath]);
      expect(admitted.state).toBe("admitted");
      if (admitted.state !== "admitted") throw new Error("dormant continuation blocked idle cohort");
      expect(() => db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?")
        .run(JSON.stringify({ version: 1, state: "claimed" }), key))
        .toThrow("agent_bridge_idle_maintenance_deferred_busy");
      expect(() => worker.insertRun("racing-run", identity, "codex"))
        .toThrow("agent_bridge_idle_maintenance_deferred_busy");
      expect(db.getSetting(key)).toBe(pending);
      expect(releaseIdleUpgradeRoles(admitted.roles)).toBe(true);
      expect(db.getSetting(key)).toBe(pending);
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("idle");
    } finally { worker.close(); }
  });

  it("releases only after exact token; survives reopening other runtime connections", () => {
    const fence = admit();
    const other = openDb(path);
    try {
      expect(() => other.insertRun("other", identity, "codex")).toThrow("agent_bridge_idle_maintenance_deferred_busy");
      expect(releaseIdleUpgrade(path, fence.token)).toBe(true);
      expect(() => other.insertRun("other", identity, "codex")).not.toThrow();
    } finally { other.close(); }
  });

  it("requires proof of containment completion to recover an owner that exited", () => {
    const fence = admit();
    // Simulate a process that has exited: Linux PIDs cannot reach 999999999.
    db.setSetting(IDLE_UPGRADE_FENCE_KEY, JSON.stringify({ ...fence, pid: 999999999, startTicks: "1" }));
    expect(recoverIdleUpgrade(path, () => false)).toBe(false);
    expect(readIdleUpgradeState(path)).toBe("deferred_busy");
    expect(recoverIdleUpgrade(path, () => true)).toBe(true);
    expect(readIdleUpgradeState(path)).toBe("idle");
  });

  it("requires containment proof to recover a prior-boot owner even if the PID was reused", () => {
    const fence = admit();
    const oldBootId = fence.bootId === "00000000-0000-0000-0000-000000000001"
      ? "00000000-0000-0000-0000-000000000002"
      : "00000000-0000-0000-0000-000000000001";
    // Keep the live test process PID and start ticks. On reboot they can be
    // recycled: only boot identity distinguishes the original owner.
    db.setSetting(IDLE_UPGRADE_FENCE_KEY, JSON.stringify({ ...fence, bootId: oldBootId }));
    expect(recoverIdleUpgrade(path, () => false)).toBe(false);
    expect(readIdleUpgradeState(path)).toBe("deferred_busy");
    expect(recoverIdleUpgrade(path, () => true)).toBe(true);
    expect(readIdleUpgradeState(path)).toBe("idle");
  });

  it("never releases an apparently live owner based only on an external assertion", () => {
    admit();
    expect(recoverIdleUpgrade(path, () => true)).toBe(false);
    expect(readIdleUpgradeState(path)).toBe("deferred_busy");
  });

  it("fails closed on missing files, malformed markers and malformed deferred state", () => {
    const missing = join(dir, "not-created.sqlite");
    expect(readIdleUpgradeState(missing)).toBe("unknown");
    expect(tryAdmitIdleUpgrade(missing).state).toBe("unknown");
    db.setSetting(IDLE_UPGRADE_FENCE_KEY, "{}");
    expect(readIdleUpgradeState(path)).toBe("unknown");
    expect(tryAdmitIdleUpgrade(path).state).toBe("unknown");
    db.setSetting(IDLE_UPGRADE_FENCE_KEY, null);
    db.raw.prepare("DELETE FROM settings WHERE key = ?").run(IDLE_UPGRADE_FENCE_KEY);
    db.setSetting("run-continuation:v1:broken", "{not-json");
    expect(tryAdmitIdleUpgrade(path).state).toBe("unknown");
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'ab_idle_maintenance_%'").get())
      .toMatchObject({ n: 0 });
  });

  it("defers a whole database cohort when another role admits work first", () => {
    const workerPath = join(dir, "worker.sqlite");
    const worker = openDb(workerPath);
    try {
      worker.insertRun("active-worker", identity, "claude");
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("deferred_busy");
      expect(tryAdmitIdleUpgradeRoles([workerPath, path], process.pid)).toEqual({ state: "deferred_busy" });
      // Acquisition of the first sorted role must have been rolled back.
      expect(readIdleUpgradeState(path)).toBe("idle");
      expect(db.getSetting(IDLE_UPGRADE_FENCE_KEY)).toBeNull();
      worker.updateRunCompleted("active-worker", "completed", null);
      const admitted = tryAdmitIdleUpgradeRoles([workerPath, path], process.pid);
      expect(admitted.state).toBe("admitted");
      if (admitted.state !== "admitted") throw new Error("failed to admit cohort");
      expect(admitted.roles.map((role) => role.dbPath)).toEqual([path, workerPath].sort());
      expect(() => db.insertRun("race-interactive", identity, "codex")).toThrow("agent_bridge_idle_maintenance_deferred_busy");
      expect(() => worker.insertRun("race-worker", identity, "codex")).toThrow("agent_bridge_idle_maintenance_deferred_busy");
      expect(releaseIdleUpgradeRoles(admitted.roles)).toBe(true);
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("idle");
      expect(() => worker.insertRun("now-admitted", identity, "codex")).not.toThrow();
    } finally { worker.close(); }
  });

  it("fails closed if a required database role is missing, duplicated or malformed", () => {
    const missing = join(dir, "missing.sqlite");
    expect(tryAdmitIdleUpgradeRoles([path, missing])).toEqual({ state: "unknown" });
    expect(tryAdmitIdleUpgradeRoles([path, path])).toEqual({ state: "unknown" });
    expect(readIdleUpgradeRolesState([path, missing])).toBe("unknown");
    expect(readIdleUpgradeRolesState([])).toBe("unknown");
    expect(readIdleUpgradeState(path)).toBe("idle");
    expect(tryAdmitIdleUpgradeRoles([path], 999999999)).toEqual({ state: "unknown" });
  });

  it("recognises an in-flight outward reservation rather than claiming idle", () => {
    db.setSetting("outward-queue-reservation:race", "pending");
    expect(readIdleUpgradeState(path)).toBe("deferred_busy");
    expect(tryAdmitIdleUpgradeRoles([path])).toEqual({ state: "deferred_busy" });
    db.raw.prepare("DELETE FROM settings WHERE key = ?").run("outward-queue-reservation:race");
    expect(readIdleUpgradeState(path)).toBe("idle");
  });

  it("keeps an orphan fence until a trusted containment proof then resumes admission", () => {
    const workerPath = join(dir, "worker.sqlite");
    const worker = openDb(workerPath);
    try {
      const admitted = tryAdmitIdleUpgradeRoles([path, workerPath]);
      if (admitted.state !== "admitted") throw new Error("failed to admit cohort");
      for (const role of admitted.roles) {
        const owner = { ...role.fence, pid: 999999999, startTicks: "1" };
        const target = role.dbPath === path ? db : worker;
        target.setSetting(IDLE_UPGRADE_FENCE_KEY, JSON.stringify(owner));
        expect(recoverIdleUpgrade(role.dbPath, () => false)).toBe(false);
      }
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("deferred_busy");
      expect(recoverIdleUpgradeRoles([path, workerPath], () => false)).toBe(false);
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("deferred_busy");
      expect(recoverIdleUpgradeRoles([path, workerPath], () => true)).toBe(true);
      expect(recoverIdleUpgradeRoles([path, workerPath], () => true)).toBe(true);
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("idle");
      expect(() => worker.insertRun("after-recovery", identity, "claude")).not.toThrow();
    } finally { worker.close(); }
  });

  it("does not recover only the first role when another cohort owner is still alive", () => {
    const workerPath = join(dir, "worker.sqlite");
    const worker = openDb(workerPath);
    try {
      const result = tryAdmitIdleUpgradeRoles([path, workerPath]);
      if (result.state !== "admitted") throw new Error("expected idle cohort");
      const first = result.roles[0];
      const last = result.roles[1];
      const owner = { ...first.fence, pid: 999999999, startTicks: "1" };
      db.setSetting(IDLE_UPGRADE_FENCE_KEY, JSON.stringify(owner));

      // The second marker still belongs to this live process. Recovering the
      // dead first role alone would violate the all-or-none containment gate.
      expect(recoverIdleUpgradeRoles([path, workerPath], () => true)).toBe(false);
      expect(readIdleUpgradeState(path)).toBe("deferred_busy");
      expect(readIdleUpgradeState(workerPath)).toBe("deferred_busy");
      expect(() => db.insertRun("should-not-admit", identity, "claude"))
        .toThrow("agent_bridge_idle_maintenance_deferred_busy");
      expect(releaseIdleUpgrade(workerPath, last.fence.token)).toBe(true);
      expect(recoverIdleUpgradeRoles([path, workerPath], () => true)).toBe(true);
      expect(readIdleUpgradeRolesState([path, workerPath])).toBe("idle");
    } finally { worker.close(); }
  });

  it("requires exact tokens for each role and attempts remaining cleanup after a mismatch", () => {
    const workerPath = join(dir, "worker.sqlite");
    const worker = openDb(workerPath);
    try {
      const admitted = tryAdmitIdleUpgradeRoles([path, workerPath]);
      if (admitted.state !== "admitted") throw new Error("failed to admit cohort");
      const mismatched = admitted.roles.map((role) => ({
        ...role, fence: { ...role.fence, token: role.dbPath === path ? "00000000-0000-0000-0000-000000000000" : role.fence.token },
      }));
      expect(releaseIdleUpgradeRoles(mismatched)).toBe(false);
      expect(readIdleUpgradeState(workerPath)).toBe("idle");
      expect(readIdleUpgradeState(path)).toBe("deferred_busy");
      expect(releaseIdleUpgrade(path, admitted.roles.find((role) => role.dbPath === path)!.fence.token)).toBe(true);
    } finally { worker.close(); }
  });
});
