import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  cleanupStaleOutwardAcpAttachments,
  referencedQueuedAttachmentDirs,
  retainOutwardAcpAttachmentsForWait,
  stageOutwardAcpAttachments,
} from "../src/acpServer/attachments.js";
import { OutwardRecoveryGate, outwardRecoveryEvidence } from "../src/acpServer/continuationWorker.js";
import { OUTWARD_ACP_SURFACE } from "../src/acpServer/recovery.js";

// Issue #1130 correction: reclaim only provably orphaned queued snapshots, and
// keep the worker's full reconciliation bounded.

const HOUR = 60 * 60 * 1000;
const file = { type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "body" } } as const;

async function retain(root: string, id: string): Promise<string> {
  await stageOutwardAcpAttachments(root, [file], (paths) => retainOutwardAcpAttachmentsForWait(root, paths, id));
  const name = readdirSync(root).find((entry) => entry.startsWith(".agent-bridge-queued-attachments-") && !seen.has(entry))!;
  seen.add(name);
  return name;
}
const seen = new Set<string>();
const age = (root: string, name: string, ms: number) => {
  const when = new Date(Date.now() - ms);
  utimesSync(join(root, name), when, when);
};

describe("orphaned queued attachment snapshots", () => {
  it("removes an old unreferenced snapshot but keeps referenced, recent, unverified and unscoped ones", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "queue-orphans-")));
    try {
      const orphan = await retain(root, "acp-queue-orphan");
      const referenced = await retain(root, "acp-queue-referenced");
      const recent = await retain(root, "acp-queue-recent");
      const foreign = await retain(root, "acp-queue-foreign");
      writeFileSync(join(root, foreign, ".agent-bridge-staging-owner"), "someone else\n");
      for (const name of [orphan, referenced, foreign]) age(root, name, 30 * 24 * HOUR);
      age(root, recent, 5 * 60 * 1000);

      const db = openDb(":memory:");
      db.admitMessage(OUTWARD_ACP_SURFACE, "acp:c1", {
        prompt: "queued for a long time", chatId: "s1", chatType: "acp", attachments: ["acp-retained:acp-queue-referenced"],
        scheduledOccurrenceKey: "acp-queue:k",
      }, 5, true);
      const rows = (db.raw.prepare("SELECT attachments_json AS json FROM pending_messages WHERE surface = ?")
        .all(OUTWARD_ACP_SURFACE) as Array<{ json: string }>).map((row) => row.json);
      const refs = referencedQueuedAttachmentDirs(rows);

      // Without a complete reference set nothing queued is ever touched.
      expect(await cleanupStaleOutwardAcpAttachments(root)).toBe(0);
      expect(readdirSync(root).filter((e) => e.startsWith(".agent-bridge-queued"))).toHaveLength(4);

      expect(await cleanupStaleOutwardAcpAttachments(root, [], Date.now(), refs)).toBe(1);
      const left = readdirSync(root).filter((e) => e.startsWith(".agent-bridge-queued"));
      expect(left.sort()).toEqual([foreign, recent, referenced].sort());
      expect(existsSync(join(root, orphan))).toBe(false);
      // A valid queued task survives however long it waits.
      expect(await cleanupStaleOutwardAcpAttachments(root, [], Date.now() + 400 * 24 * HOUR, refs)).toBe(1); // only the now-old unreferenced "recent"
      expect(existsSync(join(root, referenced))).toBe(true);
      expect(existsSync(join(root, foreign))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a snapshot whose private permissions cannot be verified", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "queue-orphans-perm-")));
    try {
      const name = await retain(root, "acp-queue-open");
      chmodSync(join(root, name), 0o755);
      age(root, name, 30 * 24 * HOUR);
      expect(await cleanupStaleOutwardAcpAttachments(root, [], Date.now(), new Set())).toBe(0);
      expect(existsSync(join(root, name))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when a queue reference cannot be read", () => {
    expect(() => referencedQueuedAttachmentDirs(["not json"])).toThrow(/unreadable/);
  });
});

describe("worker recovery gating", () => {
  it("does nothing while the outward surface is idle", () => {
    const db = openDb(":memory:");
    expect(outwardRecoveryEvidence(db)).toBe("");
    const gate = new OutwardRecoveryGate();
    for (let tick = 0; tick < 50; tick += 1) expect(gate.shouldReconcile("")).toBe(false);
  });

  it("reconciles on new evidence at once, backs off while it is unchanged and resets when it clears", () => {
    const db = openDb(":memory:");
    db.admitMessage(OUTWARD_ACP_SURFACE, "acp:c1", { prompt: "p", chatId: "s", chatType: "acp", scheduledOccurrenceKey: "k" }, 5, true);
    expect(outwardRecoveryEvidence(db)).toBe("|1");
    db.insertRun("r1", { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:c2" }, "codex");
    expect(outwardRecoveryEvidence(db)).toBe("r1|1");

    const gate = new OutwardRecoveryGate();
    const ticks = Array.from({ length: 60 }, () => gate.shouldReconcile("r1|1"));
    expect(ticks[0]).toBe(true);
    // First retries come quickly, then at most once per twelve ticks (about a minute).
    const runs = ticks.flatMap((did, index) => (did ? [index] : []));
    expect(runs.slice(0, 4)).toEqual([0, 1, 3, 6]);
    expect(Math.max(...runs.slice(1).map((value, index) => value - runs[index]))).toBeLessThanOrEqual(12);
    expect(runs.length).toBeLessThan(10);
    // New evidence is never delayed by an earlier backoff; clearing it resets.
    expect(gate.shouldReconcile("r2|1")).toBe(true);
    expect(gate.shouldReconcile("")).toBe(false);
    expect(gate.shouldReconcile("r2|1")).toBe(true);
  });
});
