import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  IDLE_UPGRADE_FENCE_KEY, readIdleUpgradeState, recoverIdleUpgrade,
  releaseIdleUpgrade, tryAdmitIdleUpgrade,
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

  it("defers accepted queued work, claimed work, open receipts and future continuations", () => {
    const id = db.enqueueMsg(identity.surfaceIdentity, identity.chatKey, { prompt: "pending", chatId: "isolated", chatType: "acp" });
    expect(tryAdmitIdleUpgrade(path).state).toBe("deferred_busy");
    db.deletePendingMsg(id);
    db.createEventReceipt(event);
    expect(tryAdmitIdleUpgrade(path).state).toBe("deferred_busy");
    db.raw.prepare("DELETE FROM event_receipts WHERE idempotency_key = ?").run(event.idempotency_key);
    db.setSetting("run-continuation:v1:delayed", JSON.stringify({ version: 1, state: "pending" }));
    expect(tryAdmitIdleUpgrade(path).state).toBe("deferred_busy");
    db.setSetting("run-continuation:v1:delayed", JSON.stringify({ version: 1, state: "completed" }));
    expect(tryAdmitIdleUpgrade(path).state).toBe("admitted");
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
});
