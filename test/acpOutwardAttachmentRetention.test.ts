/**
 * #1114 gap item 2: execution.ts persists a durable conversation turn and
 * Run at admission, but attachments.ts deletes private staged files as soon
 * as the current ACP request finishes. A durable capacity wait needs those
 * bytes to still exist when the task is later retried — without a second
 * transcript store, without referencing deleted paths, and without becoming
 * an unbounded accumulation.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  cleanupStaleOutwardAcpAttachments,
  releaseRetainedOutwardAcpAttachments,
  retainOutwardAcpAttachmentsForWait,
  readRetainedOutwardAcpAttachments,
  stageOutwardAcpAttachments,
} from "../src/acpServer/attachments.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "bridge-outward-attachment-retention-"));
  roots.push(path);
  return path;
}

/** Mirrors attachments.ts's retainedWaitDirName() naming scheme exactly. */
function retainedWaitDirNameFor(continuationId: string): string {
  return `.agent-bridge-attachments-wait-${createHash("sha256").update(continuationId).digest("hex").slice(0, 32)}`;
}

describe("durable attachment retention for a capacity wait (#1114)", () => {
  it("retains staged bytes past the normal per-request cleanup, keyed by continuation id", async () => {
    const cwd = workspace();
    const continuationId = "acp-capacity-wait:run-1";
    let stagedPaths: string[] = [];
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///report.csv", mimeType: "text/csv", text: "name\nAda\n" } },
    ] as ContentBlock[], async (files) => {
      stagedPaths = files;
      await retainOutwardAcpAttachmentsForWait(cwd, files, continuationId);
    });

    // The ephemeral staging directory is gone (stageOutwardAcpAttachments's
    // own finally still runs)...
    expect(stagedPaths.every((path) => !existsSync(path))).toBe(true);

    // ...but the retained copy survives, privately owned and bounded.
    const retained = await readRetainedOutwardAcpAttachments(cwd, continuationId);
    expect(retained).toHaveLength(1);
    expect(readFileSync(retained[0], "utf8")).toBe("name\nAda\n");
    expect(retained.every((path) => path.startsWith(cwd))).toBe(true);
  });

  it("returns an empty list for a continuation with no retained attachments", async () => {
    const cwd = workspace();
    await expect(readRetainedOutwardAcpAttachments(cwd, "acp-capacity-wait:none")).rejects.toThrow();
    await retainOutwardAcpAttachmentsForWait(cwd, [], "acp-capacity-wait:none");
    expect(await readRetainedOutwardAcpAttachments(cwd, "acp-capacity-wait:none")).toEqual([]);
  });

  it("releases the retained directory on settlement", async () => {
    const cwd = workspace();
    const continuationId = "acp-capacity-wait:run-2";
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "hi" } },
    ] as ContentBlock[], async (files) => { await retainOutwardAcpAttachmentsForWait(cwd, files, continuationId); });

    expect(await readRetainedOutwardAcpAttachments(cwd, continuationId)).toHaveLength(1);
    await releaseRetainedOutwardAcpAttachments(cwd, continuationId);
    await expect(readRetainedOutwardAcpAttachments(cwd, continuationId)).rejects.toThrow();
  });

  it("refuses to reuse a pre-existing, unverified directory at the retained-attachment path", async () => {
    const cwd = workspace();
    const continuationId = "acp-capacity-wait:attacker-planted";
    // Simulate a directory already sitting at the deterministic retained path
    // that we did not create (no owner marker) -- must never be silently
    // written into.
    const plantedDir = join(cwd, retainedWaitDirNameFor(continuationId));
    mkdirSync(plantedDir, { mode: 0o700 });
    writeFileSync(join(plantedDir, "evidence-of-attacker-content"), "not ours");

    await expect(stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "hi" } },
    ] as ContentBlock[], async (files) => {
      await retainOutwardAcpAttachmentsForWait(cwd, files, continuationId);
    })).rejects.toThrow(/unverified path/);

    expect(existsSync(join(plantedDir, "evidence-of-attacker-content"))).toBe(true);
  });

  it("rejects missing, modified, and symlinked retained files", async () => {
    const cwd = workspace();
    const id = "integrity-check";
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "original" } },
    ] as ContentBlock[], async (files) => { await retainOutwardAcpAttachmentsForWait(cwd, files, id); });
    const [path] = await readRetainedOutwardAcpAttachments(cwd, id);
    writeFileSync(path, "changed");
    await expect(readRetainedOutwardAcpAttachments(cwd, id)).rejects.toThrow();
    rmSync(path);
    await expect(readRetainedOutwardAcpAttachments(cwd, id)).rejects.toThrow();
    symlinkSync(join(cwd, "outside"), path);
    await expect(readRetainedOutwardAcpAttachments(cwd, id)).rejects.toThrow();
  });

  it("publishes at most one retention and rejects unverified extra entries", async () => {
    const cwd = workspace();
    const id = "concurrent-retention";
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "original" } },
    ] as ContentBlock[], async (files) => {
      const results = await Promise.allSettled([
        retainOutwardAcpAttachmentsForWait(cwd, files, id),
        retainOutwardAcpAttachmentsForWait(cwd, files, id),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
    const [path] = await readRetainedOutwardAcpAttachments(cwd, id);
    writeFileSync(join(path, "..", "unexpected"), "untrusted");
    await expect(readRetainedOutwardAcpAttachments(cwd, id)).rejects.toThrow();
  });

  it("releasing a continuation that was never retained is a safe no-op", async () => {
    const cwd = workspace();
    await expect(releaseRetainedOutwardAcpAttachments(cwd, "acp-capacity-wait:never")).resolves.toBeUndefined();
  });

  it("does not sweep a live retained wait directory via the ordinary stale-staging cleanup", async () => {
    const cwd = workspace();
    const continuationId = "acp-capacity-wait:run-3";
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "hi" } },
    ] as ContentBlock[], async (files) => { await retainOutwardAcpAttachmentsForWait(cwd, files, continuationId); });

    const retainedDir = join(cwd, readdirSync(cwd).find((entry) => entry.startsWith(".agent-bridge-attachments-wait-"))!);
    // Backdate it well past the ordinary 24h staging-cleanup window (but
    // short of the retained-wait sweep's own, much longer bound).
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(retainedDir, old, old);

    await cleanupStaleOutwardAcpAttachments(cwd);

    expect(await readRetainedOutwardAcpAttachments(cwd, continuationId)).toHaveLength(1);
  });

  it("the stale-wait sweep eventually reclaims an orphaned retained directory past its own long bound", async () => {
    const cwd = workspace();
    const continuationId = "acp-capacity-wait:run-4";
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "hi" } },
    ] as ContentBlock[], async (files) => { await retainOutwardAcpAttachmentsForWait(cwd, files, continuationId); });

    const retainedDir = join(cwd, readdirSync(cwd).find((entry) => entry.startsWith(".agent-bridge-attachments-wait-"))!);
    const old = (Date.now() - 9 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(retainedDir, old, old);

    await cleanupStaleOutwardAcpAttachments(cwd);

    expect(existsSync(retainedDir)).toBe(false);
  });
});
