import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { connectWithAcpInitialization } from "./support/initializedAcpClient.js";
import { openDb } from "../src/db.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent, WORKSTREAM_METHODS } from "../src/acpServer/app.js";
import type { VoiceTranscriber } from "../src/voiceIngress.js";

describe("Desk voice uses the existing local transcription ingress", () => {
  it("validates Workstream ownership and returns only transcript text without admitting a Run", async () => {
    const root = mkdtempSync(join(tmpdir(), "desk-stt-acp-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const repository = new OutwardAcpSessionRepository(db.raw);
      repository.create({ sessionId: "own-session", conversationId: "acp:desk-test", cwd: root });
      const transcribe = vi.fn(async () => ({ text: "Please inspect the workspace." }));
      const voiceTranscriber: VoiceTranscriber = { name: "stub", available: true, transcribe };
      const app = createOutwardAcpAgent({ sessions: repository, workspaceRoot: root, voiceTranscriber });
      const request = (params: Record<string, unknown>) =>
        connectWithAcpInitialization(acp.client({ name: "desk-voice-test" }), app, peer =>
          peer.request<{ text: string }>(WORKSTREAM_METHODS.transcribeVoice, params));
      const audioBase64 = Buffer.from("fixture voice bytes").toString("base64");
      const input = { sessionId: "own-session", cwd: root, mimeType: "audio/webm", audioBase64 };
      expect(await request(input)).toEqual({ text: "Please inspect the workspace." });
      expect(transcribe).toHaveBeenCalledTimes(1);
      await expect(request({ ...input, sessionId: "unknown" })).rejects.toMatchObject({ code: -32602 });
      await expect(request({ ...input, cwd: "/tmp" })).rejects.toMatchObject({ code: -32602 });
      await expect(request({ ...input, mimeType: "application/pdf" })).rejects.toMatchObject({ code: -32602 });
      await expect(request({ ...input, audioBase64: "%invalid%" })).rejects.toMatchObject({ code: -32602 });
      await expect(request({ ...input, audioBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }))
        .rejects.toThrow(); // The ACP transport may reject very large JSON-RPC frames before validation.
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(db.getRecentConvTurns("acp:desk-test", 10, undefined, "acp:outward")).toEqual([]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
