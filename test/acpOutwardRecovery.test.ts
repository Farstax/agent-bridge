import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { readProcessStartTicks } from "../src/cliSupervisor.js";
import { openDb } from "../src/db.js";
import { OUTWARD_ACP_SURFACE, recoverOutwardLanes } from "../src/acpServer/recovery.js";

describe("outward ACP crash recovery", () => {
  it("retains an unexpired lease and later reconciles only after owner and provider are absent", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(owner, "spawn");
    const ticks = readProcessStartTicks(owner.pid)!;
    expect(ticks).toBeTruthy();
    const db = openDb(":memory:", { serviceId: `acp:outward/${owner.pid}/${ticks}`, runId: "lock-owner" });
    try {
      const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:crashed" };
      db.insertRun("provider-run", identity, "codex");
      expect(db.acquireLock(identity.surfaceIdentity, identity.chatKey)).not.toBeNull();
      db.raw.prepare("UPDATE execution_locks SET lease_expires_at = ?").run(new Date(0).toISOString());
      await recoverOutwardLanes(db);
      expect(db.hasChatLock(identity.chatKey)).toBe(true);
      expect(db.getRun("provider-run").status).toBe("running");
      owner.kill("SIGKILL");
      await once(owner, "exit");
      db.raw.prepare("UPDATE execution_locks SET lease_expires_at = ?").run(new Date(Date.now() + 60_000).toISOString());
      await recoverOutwardLanes(db);
      expect(db.hasChatLock(identity.chatKey)).toBe(true);
      db.raw.prepare("UPDATE execution_locks SET lease_expires_at = ?").run(new Date(0).toISOString());
      await recoverOutwardLanes(db);
      expect(db.hasChatLock(identity.chatKey)).toBe(false);
      expect(db.getRun("provider-run").status).toBe("failed");
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGKILL"); await once(owner, "exit"); }
      db.close();
    }
  });

  it("finishes a safely released lane when recovery was interrupted before the Run transition", async () => {
    const db = openDb(":memory:", { serviceId: `acp:outward/${process.pid}/0`, runId: "old-owner" });
    try {
      const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:interrupted" };
      db.insertRun("interrupted-provider", identity, "codex");
      expect(db.acquireLock(identity.surfaceIdentity, identity.chatKey)).not.toBeNull();
      db.raw.prepare("UPDATE execution_locks SET lease_expires_at = ?").run(new Date(0).toISOString());
      expect(db.reconcileStaleExecutionLocks({ reason: "outward_acp_service_restart", containmentState: () => "proven", lockState: () => "stale" })).toHaveLength(1);
      await recoverOutwardLanes(db);
      expect(db.getRun("interrupted-provider").status).toBe("failed");
    } finally { db.close(); }
  });

  it("keeps unknown legacy ownership fenced", async () => {
    const db = openDb(":memory:", { serviceId: "acp:outward", runId: "legacy" });
    try {
      db.insertRun("old-provider", { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:old" }, "codex");
      expect(db.acquireLock(OUTWARD_ACP_SURFACE, "acp:old")).not.toBeNull();
      db.raw.prepare("UPDATE execution_locks SET lease_expires_at = ?").run(new Date(0).toISOString());
      await recoverOutwardLanes(db);
      expect(db.hasChatLock("acp:old")).toBe(true);
      expect(db.getRun("old-provider").status).toBe("running");
    } finally { db.close(); }
  });
  it("provides controlled recovery for legacy locks only at a quiesced rollout boundary", () => {
    const db = openDb(":memory:", { serviceId: "acp:outward", runId: "legacy" });
    try {
      const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:legacy-rollout" };
      db.insertRun("legacy-provider", identity, "codex");
      expect(db.acquireLock(identity.surfaceIdentity, identity.chatKey)).not.toBeNull();
      db.raw.prepare("UPDATE execution_locks SET lease_expires_at = ?").run(new Date(0).toISOString());
      // Connection startup cannot prove that the old process is gone.
      // The administrative, quiesced-rollout owner has a separate audited path.
      const result = db.reconcileControlledRollout({ reason: "operator_verified_quiescence" });
      expect(result.releasedLockCount).toBe(1);
      expect(db.hasChatLock(identity.chatKey)).toBe(false);
      expect(db.getRun("legacy-provider").status).toBe("failed");
    } finally { db.close(); }
  });

});
