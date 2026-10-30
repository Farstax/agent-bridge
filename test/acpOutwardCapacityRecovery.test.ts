import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { claimDueRunContinuation, listRunContinuations, requestRunContinuation } from "../src/runContinuation.js";
import { stageOutwardAcpAttachments, retainOutwardAcpAttachmentsForWait } from "../src/acpServer/attachments.js";
import { resumeOutwardCapacityWait } from "../src/acpServer/continuationWorker.js";
import type { OutwardAcpPromptExecutor } from "../src/acpServer/execution.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("outward ACP durable capacity worker (#1114)", () => {
  it("resumes a retained task and its exact attachments after DB restart without an ACP client", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-acp-wait-restart-"));
    roots.push(root);
    const path = join(root, "state.sqlite");
    const original = openDb(path, { databaseRole: "interactive" });
    const repo = new OutwardAcpSessionRepository(original.raw);
    const session = repo.create({ sessionId: "workstream-1", conversationId: "acp:c1", cwd: root });
    original.insertRun("capacity-origin", { surfaceIdentity: "acp:outward", chatKey: session.conversationId }, "codex");
    original.updateRunFailed("capacity-origin", "MODEL_CAPACITY_EXHAUSTED");
    const now = Date.now();
    const wait = requestRunContinuation(original, {
      originRunId: "capacity-origin", surfaceIdentity: "acp:outward",
      chatKey: session.conversationId, provider: "codex", capacityWait: true,
      reason: "provider capacity", afterSeconds: 5,
      outward: { sessionId: session.sessionId, prompt: "review report", attachmentCount: 1 },
    }, now);
    await stageOutwardAcpAttachments(root, [
      { type: "resource", resource: { uri: "file:///report.txt", mimeType: "text/plain", text: "saved payload" } },
    ], async (files) => { await retainOutwardAcpAttachmentsForWait(root, files, wait.id); });
    original.close();

    const reopened = openDb(path, { databaseRole: "interactive" });
    try {
      const claimed = claimDueRunContinuation(reopened, wait.id, now + 6_000, { runId: "worker-process" });
      expect(claimed).toMatchObject({ state: "claimed", capacityWait: true });
      const lookup = (id: string) => new OutwardAcpSessionRepository(reopened.raw).get(id);
      const execute = vi.fn(async (input: { session: { sessionId: string }; prompt: string; attachments?: string[]; capacityResume?: { id: string; claimToken: string } }) => {
        expect(input.session.sessionId).toBe("workstream-1");
        expect(input.prompt).toBe("review report");
        expect(input.attachments).toHaveLength(1);
        expect(input.capacityResume?.id).toBe(wait.id);
        return { stopReason: "end_turn" as const };
      });
      const worker = { execute } as unknown as OutwardAcpPromptExecutor;
      expect(await resumeOutwardCapacityWait(reopened, lookup, worker, claimed!)).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(listRunContinuations(reopened, "acp:outward")[0].state).toBe("claimed");
      // A boolean callback is not evidence of completion. The actual
      // successor Run must settle before scanRunContinuations can complete.
    } finally { reopened.close(); }
  });
});
