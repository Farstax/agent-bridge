/**
 * #1114 gap item 2: execution.ts persists a durable conversation turn and
 * Run at admission, but attachments.ts deletes private staged files as soon
 * as the current ACP request finishes. A durable capacity wait needs those
 * bytes to still exist when the task is later retried — without a second
 * transcript store, without referencing deleted paths, and without becoming
 * an unbounded accumulation.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(await readRetainedOutwardAcpAttachments(cwd, continuationId)).toEqual([]);
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
