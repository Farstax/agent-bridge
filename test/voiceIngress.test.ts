import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, symlink, utimes, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adaptDiscordMessage,
  adaptTelegramUpdate,
  type InteractiveTurnInput,
} from "../src/interactiveIngress.js";
import { ExecutionLaneCoordinator } from "../src/executionLaneCoordinator.js";
import {
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_MAX_AUDIO_DURATION_SECONDS,
  acquireWorkspaceTranscriptionLease,
  prepareVoiceBatchForDispatch,
  prepareVoiceTurn,
  reapStaleVoiceTempDirs,
  runBoundedProcess,
  surfaceVoiceAudioStager,
  unavailableVoiceTranscriber,
  workspaceTranscriptionLockFile,
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

function executionLane(turn: InteractiveTurnInput): string {
  return JSON.stringify([turn.surfaceIdentity, turn.chatKey]);
}

/**
 * Mirrors BridgeEngine._installStopFence: a real /stop marks the lane aborted
 * AND explicitly aborts every open pre-provider ingress scope. Non-stop
 * busy-mode fencing (augment/interrupt) intentionally does not call
 * abortPreProviderIngress, so tests simulating /stop must invoke both, not
 * markAborted alone.
 */
function simulateStop(coordinator: ExecutionLaneCoordinator, lane: string): void {
  coordinator.markAborted(lane);
  coordinator.abortPreProviderIngress(lane);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("leaves ordinary non-voice ingress unchanged", async () => {
    const turn = audioTurn({ text: "ordinary", attachments: [] });
    const controller = new AbortController();
    const result = await prepareVoiceBatchForDispatch([turn], {
      signal: controller.signal,
      workspaceDir: process.cwd(),
      notify: vi.fn(),
    });
    expect(result).toEqual({ kind: "ready", turns: [turn] });
    expect(result.kind === "ready" ? result.turns[0] : null).toBe(turn);
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
        workspaceDir: root,
        tempRoot: root,
        maxTempBytes: 1024,
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
        workspaceDir: root,
        tempRoot: root,
        maxTempBytes: 1024,
      });
      expect(result.kind).toBe("ready");
      expect(result.kind === "ready" ? result.turn.attachments : []).toEqual([document]);
    });
  });

  it("/stop while download is held aborts staging before transcription", async () => {
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
      const coordinator = new ExecutionLaneCoordinator();
      const lane = executionLane(turn);
      const scope = coordinator.beginPreProviderIngress(lane);
      const pending = prepareVoiceBatchForDispatch([turn], {
        signal: scope.controller.signal,
        workspaceDir: root,
        stager,
        transcriber,
        tempRoot: root,
        maxTempBytes: 1024,
        notify: vi.fn(),
      });
      await stageStarted.promise;

      simulateStop(coordinator, lane);
      releaseStage.resolve();
      expect(await pending).toEqual({ kind: "drop" });
      expect(transcribeSpy).not.toHaveBeenCalled();
      expect(coordinator.claimPreProviderIngress(lane, scope)).toBe(false);
      coordinator.clearPreProviderIngress(lane, scope);
    });
  });

  it("/stop while transcription is held cleans scratch and fences admission", async () => {
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
      const coordinator = new ExecutionLaneCoordinator();
      const lane = executionLane(turn);
      const scope = coordinator.beginPreProviderIngress(lane);
      const pending = prepareVoiceBatchForDispatch([turn], {
        signal: scope.controller.signal,
        workspaceDir: root,
        stager: writingStager((dir) => { operationDir = dir; }),
        transcriber,
        tempRoot: root,
        maxTempBytes: 1024,
        notify: vi.fn(),
      });
      await transcriptionStarted.promise;

      simulateStop(coordinator, lane);
      releaseTranscription.resolve();
      expect(await pending).toEqual({ kind: "drop" });
      expect(coordinator.claimPreProviderIngress(lane, scope)).toBe(false);
      expect(operationDir).not.toBe("");
      expect(await pathExists(operationDir)).toBe(false);
      coordinator.clearPreProviderIngress(lane, scope);
    });
  });

  it("/stop accepted at the STT-to-Run boundary makes the synchronous claim fail", async () => {
    await withTempRoot(async (root) => {
      const turn = audioTurn();
      const coordinator = new ExecutionLaneCoordinator();
      const lane = executionLane(turn);
      const scope = coordinator.beginPreProviderIngress(lane);
      const prepared = await prepareVoiceBatchForDispatch([turn], {
        signal: scope.controller.signal,
        workspaceDir: root,
        stager: writingStager(),
        transcriber: successfulTranscriber(),
        tempRoot: root,
        maxTempBytes: 1024,
        notify: vi.fn(),
      });
      expect(prepared.kind).toBe("ready");

      simulateStop(coordinator, lane);
      expect(coordinator.claimPreProviderIngress(lane, scope)).toBe(false);
      coordinator.clearPreProviderIngress(lane, scope);
    });
  });

  it("a successful handoff claim leaves cancellation to the durable execution lifecycle", () => {
    const turn = audioTurn();
    const coordinator = new ExecutionLaneCoordinator();
    const lane = executionLane(turn);
    const scope = coordinator.beginPreProviderIngress(lane);

    expect(coordinator.claimPreProviderIngress(lane, scope)).toBe(true);
    expect(coordinator.preProviderIngressCount(lane)).toBe(0);
    coordinator.markAborted(lane);
    expect(scope.state).toBe("claimed");
    expect(scope.controller.signal.aborted).toBe(false);
  });

  it("classifies a full-body download deadline as user-visible failure, not lane cancellation", async () => {
    await withTempRoot(async (root) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
      const notify = vi.fn(async () => undefined);
      const controller = new AbortController();
      const turn = audioTurn({
        surfaceIdentity: "discord:interactive",
        chatKey: "channel-1",
        delivery: { chatId: "channel-1", chatType: "private" },
        attachments: [{
          kind: "audio",
          fileId: "audio-1",
          fileName: "note.ogg",
          mimeType: "audio/ogg",
          fileSize: 3,
          durationSeconds: 1,
          remoteUrl: "https://cdn.discordapp.com/attachments/1/2/note.ogg",
        }],
      });

      expect(await prepareVoiceBatchForDispatch([turn], {
        signal: controller.signal,
        workspaceDir: root,
        stager: surfaceVoiceAudioStager,
        transcriber: successfulTranscriber(),
        tempRoot: root,
        maxTempBytes: 1024,
        downloadTimeoutMs: 20,
        notify,
      })).toEqual({ kind: "drop" });
      expect(controller.signal.aborted).toBe(false);
      expect(notify).toHaveBeenCalledWith(turn, expect.stringContaining("timed out"));
    });
  });

  it("cleans temporary media when transcription reports a timeout", async () => {
    await withTempRoot(async (root) => {
      let operationDir = "";
      const transcriber: VoiceTranscriber = {
        name: "timeout",
        available: true,
        async transcribe({ operationDir: dir }) {
          await mkdir(join(dir, "descendant-artifacts"));
          await writeFile(join(dir, "descendant-artifacts", "partial.txt"), "partial");
          throw new Error("Voice helper timed out after 10ms.");
        },
      };
      const result = await prepareVoiceTurn(audioTurn(), {
        transcriber,
        stager: writingStager((dir) => { operationDir = dir; }),
        signal: new AbortController().signal,
        workspaceDir: root,
        tempRoot: root,
        maxTempBytes: 1024,
      });
      expect(result.kind).toBe("failed");
      expect(result.kind === "failed" ? result.error.message : "").toContain("timed out");
      expect(await pathExists(operationDir)).toBe(false);
    });
  });

  it("kills the helper's real descendant process on timeout, not just the helper itself", async () => {
    if (process.platform !== "linux") return;
    await withTempRoot(async (root) => {
      const pidFile = join(root, "descendant.pid");
      const controller = new AbortController();
      const script = 'sleep 60 & echo $! > "$1"; wait';
      const outcome = runBoundedProcess("bash", ["-c", script, "bash", pidFile], {
        cwd: root,
        signal: controller.signal,
        timeoutMs: 150,
      });
      await expect(outcome).rejects.toThrow(/timed out/);

      for (let i = 0; i < 40 && !(await pathExists(pidFile)); i += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      const descendantPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

      let descendantAlive = true;
      for (let i = 0; i < 40; i += 1) {
        try {
          process.kill(descendantPid, 0);
        } catch {
          descendantAlive = false;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(descendantAlive).toBe(false);
    });
  });

  it("permits only one active transcription lease per workspace across processes", async () => {
    if (process.platform !== "linux") return;
    await withTempRoot(async (root) => {
      const first = await acquireWorkspaceTranscriptionLease(root, new AbortController().signal);
      await expect(acquireWorkspaceTranscriptionLease(root, new AbortController().signal))
        .rejects.toThrow("already running for this workspace");
      await first.release();
      const second = await acquireWorkspaceTranscriptionLease(root, new AbortController().signal);
      await second.release();
    });
  });

  it("recovers the workspace lease after a holder process is killed and leaves only a stale lock file", async () => {
    if (process.platform !== "linux") return;
    const flock = existsSync("/usr/bin/flock") ? "/usr/bin/flock" : existsSync("/bin/flock") ? "/bin/flock" : null;
    if (!flock) return;
    await withTempRoot(async (root) => {
      const lockFile = workspaceTranscriptionLockFile(root);
      await mkdir(dirname(lockFile), { recursive: true });
      const holder = spawn(flock, ["--exclusive", lockFile, process.execPath, "-e", 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);'], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      await new Promise<void>((resolveReady, rejectReady) => {
        let stdout = "";
        holder.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes("READY\n")) resolveReady();
        });
        holder.once("error", rejectReady);
        holder.once("close", (code) => { if (!stdout.includes("READY\n")) rejectReady(new Error(`holder exited ${code}`)); });
      });

      await expect(acquireWorkspaceTranscriptionLease(root, new AbortController().signal))
        .rejects.toThrow("already running for this workspace");
      if (holder.pid) process.kill(-holder.pid, "SIGKILL");
      await new Promise<void>((resolveClosed) => holder.once("close", () => resolveClosed()));

      expect(await pathExists(lockFile)).toBe(true);
      const recovered = await acquireWorkspaceTranscriptionLease(root, new AbortController().signal);
      await recovered.release();
    });
  });

  it("surfaces transcription failure and cleans scratch", async () => {
    await withTempRoot(async (root) => {
      let operationDir = "";
      const notify = vi.fn(async () => undefined);
      const transcriber: VoiceTranscriber = {
        name: "broken",
        available: true,
        async transcribe() { throw new Error("decoder failed"); },
      };
      const controller = new AbortController();
      const prepared = await prepareVoiceBatchForDispatch([audioTurn()], {
        signal: controller.signal,
        workspaceDir: root,
        stager: writingStager((dir) => { operationDir = dir; }),
        transcriber,
        tempRoot: root,
        maxTempBytes: 1024,
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
