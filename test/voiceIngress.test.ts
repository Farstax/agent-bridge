import { access, mkdir, mkdtemp, symlink, utimes, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adaptDiscordMessage,
  adaptTelegramUpdate,
  type InteractiveTurnInput,
} from "../src/interactiveIngress.js";
import { ExecutionLaneCoordinator } from "../src/executionLaneCoordinator.js";
import {
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_MAX_AUDIO_DURATION_SECONDS,
  abortVoiceIngressLane,
  executionLaneKey,
  prepareVoiceBatchForDispatch,
  prepareVoiceTurn,
  reapStaleVoiceTempDirs,
  unavailableVoiceTranscriber,
  type VoiceAudioStager,
  type VoiceTranscriber,
} from "../src/voiceIngress.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function audioTurn(overrides: Partial<InteractiveTurnInput> = {}): InteractiveTurnInput {
  return {
    surfaceIdentity: "telegram:interactive",
    chatKey: "-100123:99",
    actorId: "42",
    messageId: "9",
    text: "Please review this",
    threadId: "99",
    delivery: { chatId: -100123, chatType: "supergroup" },
    attachments: [{
      kind: "audio",
      fileId: "voice-file",
      fileName: "voice_voice-file.ogg",
      mimeType: "audio/ogg",
      fileSize: 6,
      durationSeconds: 18,
    }],
    ...overrides,
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-voice-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writingStager(capture?: (operationDir: string) => void): VoiceAudioStager {
  return {
    async stage({ operationDir }) {
      capture?.(operationDir);
      const path = join(operationDir, "input.ogg");
      await writeFile(path, "audio");
      return path;
    },
  };
}

function successfulTranscriber(text = "Review issue 684."): VoiceTranscriber {
  return {
    name: "fake",
    available: true,
    async transcribe() { return { text }; },
  };
}

describe("voice ingress", () => {
  it("adapts Telegram voice metadata, caption and topic onto the ordinary turn shape", () => {
    const update = {
      update_id: 8,
      message: {
        message_id: 9,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 42, first_name: "owner" },
        message_thread_id: 99,
        caption: "Please review this",
        voice: { file_id: "voice-file", file_unique_id: "voice-unique", duration: 18, mime_type: "audio/ogg", file_size: 12345 },
      },
    } as any;

    expect(adaptTelegramUpdate(update, "telegram:interactive", "-100123:99")).toMatchObject({
      text: "Please review this",
      threadId: "99",
      attachments: [{
        kind: "audio",
        fileId: "voice-file",
        fileName: "voice_voice-file.ogg",
        mimeType: "audio/ogg",
        fileSize: 12345,
        durationSeconds: 18,
      }],
    });
  });

  it("admits Discord attachment-only audio on the same neutral turn shape", () => {
    const turn = adaptDiscordMessage({
      id: "123456789012345678",
      channel_id: "223456789012345678",
      guild_id: "323456789012345678",
      author: { id: "423456789012345678", username: "owner" },
      content: "",
      attachments: [{
        id: "523456789012345678",
        filename: "note.ogg",
        content_type: "audio/ogg",
        size: 23456,
        url: "https://cdn.discordapp.com/attachments/1/2/note.ogg",
        duration_secs: 12.5,
      }],
    });

    expect(turn).toMatchObject({
      text: "",
      attachments: [{
        kind: "audio",
        fileId: "523456789012345678",
        fileName: "note.ogg",
        mimeType: "audio/ogg",
        fileSize: 23456,
        remoteUrl: "https://cdn.discordapp.com/attachments/1/2/note.ogg",
        durationSeconds: 12.5,
      }],
    });
  });

  it("fails before download when the STT backend is unavailable", async () => {
    const stager = { stage: vi.fn() } as unknown as VoiceAudioStager;
    const result = await prepareVoiceTurn(audioTurn(), {
      transcriber: unavailableVoiceTranscriber,
      stager,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "unavailable", reason: "Voice-note transcription is unavailable on this runtime." });
    expect(stager.stage).not.toHaveBeenCalled();
  });

  it("enforces metadata size and duration bounds before staging", async () => {
    const stager = { stage: vi.fn() } as unknown as VoiceAudioStager;
    const transcriber = successfulTranscriber();

    const tooLarge = await prepareVoiceTurn(audioTurn({
      attachments: [{ ...audioTurn().attachments[0], fileSize: DEFAULT_MAX_AUDIO_BYTES + 1 }],
    }), { transcriber, stager, signal: new AbortController().signal });
    expect(tooLarge.kind).toBe("failed");

    const tooLong = await prepareVoiceTurn(audioTurn({
      attachments: [{ ...audioTurn().attachments[0], durationSeconds: DEFAULT_MAX_AUDIO_DURATION_SECONDS + 1 }],
    }), { transcriber, stager, signal: new AbortController().signal });
    expect(tooLong.kind).toBe("failed");
    expect(stager.stage).not.toHaveBeenCalled();
  });

  it("turns caption plus transcript into one ordinary text turn and cleans temporary audio", async () => {
    await withTempRoot(async (root) => {
      let operationDir = "";
      const result = await prepareVoiceTurn(audioTurn(), {
        transcriber: successfulTranscriber(),
        stager: writingStager((dir) => { operationDir = dir; }),
        signal: new AbortController().signal,
        tempRoot: root,
        maxTempBytes: 1,
      });

      expect(result).toMatchObject({
        kind: "ready",
        turn: {
          text: "Please review this\n\n[Voice note transcript]\nReview issue 684.",
          threadId: "99",
          attachments: [],
        },
      });
      expect(operationDir).not.toBe("");
      expect(await pathExists(operationDir)).toBe(false);
    });
  });

  it("preserves non-audio attachments while replacing only the voice attachment", async () => {
    await withTempRoot(async (root) => {
      const document = { fileId: "doc", fileName: "context.txt", mimeType: "text/plain" };
      const result = await prepareVoiceTurn(audioTurn({ attachments: [...audioTurn().attachments, document] }), {
        transcriber: successfulTranscriber("spoken context"),
        stager: writingStager(),
        signal: new AbortController().signal,
        tempRoot: root,
        maxTempBytes: 1,
      });
      expect(result.kind).toBe("ready");
      expect(result.kind === "ready" ? result.turn.attachments : []).toEqual([document]);
    });
  });

  it("/stop at the download gate aborts ingress and guarantees zero transcription or handoff", async () => {
    await withTempRoot(async (root) => {
      const stageStarted = deferred();
      const releaseStage = deferred();
      const transcriber = successfulTranscriber();
      const transcribeSpy = vi.spyOn(transcriber, "transcribe");
      const stager: VoiceAudioStager = {
        async stage({ operationDir }) {
          stageStarted.resolve();
          await releaseStage.promise;
          const file = join(operationDir, "input.ogg");
          await writeFile(file, "audio");
          return file;
        },
      };
      const turn = audioTurn();
      const pending = prepareVoiceBatchForDispatch([turn], {
        stager,
        transcriber,
        tempRoot: root,
        maxTempBytes: 1,
        notify: vi.fn(),
      });
      await stageStarted.promise;

      const coordinator = new ExecutionLaneCoordinator();
      coordinator.markAborted(executionLaneKey(turn.surfaceIdentity, turn.chatKey));
      releaseStage.resolve();
      const prepared = await pending;

      expect(prepared).toEqual({ kind: "drop" });
      expect(transcribeSpy).not.toHaveBeenCalled();
    });
  });

  it("/stop at the transcription gate cleans scratch and guarantees zero ordinary Run handoff", async () => {
    await withTempRoot(async (root) => {
      const transcriptionStarted = deferred();
      const releaseTranscription = deferred();
      let operationDir = "";
      const transcriber: VoiceTranscriber = {
        name: "gated",
        available: true,
        async transcribe() {
          transcriptionStarted.resolve();
          await releaseTranscription.promise;
          return { text: "This must never become a Run." };
        },
      };
      const turn = audioTurn();
      const pending = prepareVoiceBatchForDispatch([turn], {
        stager: writingStager((dir) => { operationDir = dir; }),
        transcriber,
        tempRoot: root,
        maxTempBytes: 1,
        notify: vi.fn(),
      });
      await transcriptionStarted.promise;

      const coordinator = new ExecutionLaneCoordinator();
      coordinator.markAborted(executionLaneKey(turn.surfaceIdentity, turn.chatKey));
      releaseTranscription.resolve();
      const prepared = await pending;

      expect(prepared).toEqual({ kind: "drop" });
      expect(operationDir).not.toBe("");
      expect(await pathExists(operationDir)).toBe(false);
    });
  });

  it("/stop accepted at the STT-to-Run handoff boundary guarantees zero provider admission", async () => {
    await withTempRoot(async (root) => {
      const turn = audioTurn();
      const prepared = await prepareVoiceBatchForDispatch([turn], {
        stager: writingStager(),
        transcriber: successfulTranscriber(),
        tempRoot: root,
        maxTempBytes: 1,
        notify: vi.fn(),
      });
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") throw new Error("expected prepared voice turn");

      const coordinator = new ExecutionLaneCoordinator();
      coordinator.markAborted(executionLaneKey(turn.surfaceIdentity, turn.chatKey));
      const providerAdmissions = vi.fn();
      await prepared.handoff(providerAdmissions);

      expect(providerAdmissions).not.toHaveBeenCalled();
    });
  });

  it("hands prepared speech to the ordinary path exactly once after atomically claiming the boundary", async () => {
    await withTempRoot(async (root) => {
      const turn = audioTurn();
      const prepared = await prepareVoiceBatchForDispatch([turn], {
        stager: writingStager(),
        transcriber: successfulTranscriber("ordinary text"),
        tempRoot: root,
        maxTempBytes: 1,
        notify: vi.fn(),
      });
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") throw new Error("expected prepared voice turn");

      const providerAdmissions = vi.fn(async () => undefined);
      await prepared.handoff(providerAdmissions);

      expect(providerAdmissions).toHaveBeenCalledTimes(1);
      expect(abortVoiceIngressLane(executionLaneKey(turn.surfaceIdentity, turn.chatKey))).toBe(false);
      expect(prepared.turns[0].text).toContain("ordinary text");
    });
  });

  it("surfaces transcription failure, cleans scratch and never exposes a handoff", async () => {
    await withTempRoot(async (root) => {
      let operationDir = "";
      const notify = vi.fn(async () => undefined);
      const transcriber: VoiceTranscriber = {
        name: "broken",
        available: true,
        async transcribe() { throw new Error("decoder failed"); },
      };
      const prepared = await prepareVoiceBatchForDispatch([audioTurn()], {
        stager: writingStager((dir) => { operationDir = dir; }),
        transcriber,
        tempRoot: root,
        maxTempBytes: 1,
        notify,
      });

      expect(prepared).toEqual({ kind: "drop" });
      expect(notify).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("decoder failed"));
      expect(await pathExists(operationDir)).toBe(false);
    });
  });

  it("reaps only stale managed voice directories and never follows symlinks", async () => {
    await withTempRoot(async (root) => {
      const stale = join(root, "voice-stale");
      const fresh = join(root, "voice-fresh");
      const unrelated = join(root, "other-dir");
      const external = await mkdtemp(join(tmpdir(), "agent-bridge-voice-external-"));
      const linked = join(root, "voice-linked");
      try {
        await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);
        await symlink(external, linked, "dir");
        const nowMs = Date.parse("2026-09-06T00:00:00.000Z");
        const staleDate = new Date(nowMs - 10_000);
        const freshDate = new Date(nowMs - 1_000);
        await utimes(stale, staleDate, staleDate);
        await utimes(fresh, freshDate, freshDate);
        await utimes(unrelated, staleDate, staleDate);

        expect(await reapStaleVoiceTempDirs(root, { nowMs, staleAfterMs: 5_000 })).toBe(1);
        expect(await pathExists(stale)).toBe(false);
        expect(await pathExists(fresh)).toBe(true);
        expect(await pathExists(unrelated)).toBe(true);
        expect(await pathExists(linked)).toBe(true);
        expect(await pathExists(external)).toBe(true);
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
  });
});
