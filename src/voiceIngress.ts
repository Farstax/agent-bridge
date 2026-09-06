import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { InteractiveAttachment, InteractiveTurnInput } from "./interactiveIngress.js";

export const DEFAULT_VOICE_TEMP_ROOT = join(tmpdir(), "agent-bridge-voice");
export const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_AUDIO_DURATION_SECONDS = 120;
export const DEFAULT_VOICE_TRANSCRIPTION_TIMEOUT_MS = 90_000;
export const DEFAULT_VOICE_CONVERSION_TIMEOUT_MS = 10_000;
export const DEFAULT_VOICE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const DEFAULT_VOICE_TEMP_BYTES = 32 * 1024 * 1024;
export const DEFAULT_VOICE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export const WHISPER_CPP_RELEASE = "b4938";
export const WHISPER_CPP_SOURCE_COMMIT = "52a939a2a762224e255d366c1182b2af4dd1a032";
export const WHISPER_CPP_UBUNTU_X64_ARCHIVE_SHA256 = "f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061";
export const WHISPER_CPP_MODEL_NAME = "ggml-base.en-q5_1.bin";
export const WHISPER_CPP_MODEL_SHA256 = "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f";
export const PINNED_FFMPEG_PACKAGE_VERSION = "7:6.1.1-3ubuntu5";

const DEFAULT_STT_ROOT = process.env.AGENT_BRIDGE_STT_ROOT || "/var/lib/agent-bridge/stt";
const DEFAULT_COMPONENT_ROOT = join(DEFAULT_STT_ROOT, "current");
const DEFAULT_MODEL_PATH = join(DEFAULT_STT_ROOT, "models", WHISPER_CPP_MODEL_NAME);
const DEFAULT_MANIFEST_PATH = join(DEFAULT_COMPONENT_ROOT, "manifest.json");
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROCESS_OUTPUT_LIMIT = 1024 * 1024;

type VoiceScopeState = "preparing" | "aborted" | "handed-off";
interface VoiceIngressScope {
  lane: string;
  controller: AbortController;
  state: VoiceScopeState;
}

const voiceScopes = new Map<string, VoiceIngressScope>();

export interface VoiceTranscriber {
  readonly name: string;
  readonly available: boolean;
  transcribe(input: {
    filePath: string;
    operationDir: string;
    mimeType?: string;
    signal: AbortSignal;
    maxDurationSeconds: number;
  }): Promise<{ text: string }>;
}

export interface VoiceAudioStager {
  stage(input: {
    attachment: InteractiveAttachment;
    operationDir: string;
    surfaceIdentity: string;
    signal: AbortSignal;
    maxAudioBytes: number;
  }): Promise<string>;
}

export type VoicePreparationResult =
  | { kind: "ready"; turn: InteractiveTurnInput }
  | { kind: "unavailable"; reason: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: Error };

export type VoiceBatchPreparation =
  | {
      kind: "ready";
      turns: InteractiveTurnInput[];
      handoff: (operation: () => void | Promise<void>) => Promise<void>;
    }
  | { kind: "drop" };

export interface PrepareVoiceTurnOptions {
  transcriber: VoiceTranscriber;
  stager: VoiceAudioStager;
  signal: AbortSignal;
  tempRoot?: string;
  maxAudioBytes?: number;
  maxDurationSeconds?: number;
  maxTempBytes?: number;
}

export interface PrepareVoiceBatchOptions {
  transcriber?: VoiceTranscriber;
  stager?: VoiceAudioStager;
  notify?: (turn: InteractiveTurnInput, message: string) => Promise<void>;
  tempRoot?: string;
  maxAudioBytes?: number;
  maxDurationSeconds?: number;
  maxTempBytes?: number;
}

export const unavailableVoiceTranscriber: VoiceTranscriber = Object.freeze({
  name: "unavailable",
  available: false,
  async transcribe(): Promise<{ text: string }> {
    throw new Error("Voice-note transcription is unavailable on this runtime.");
  },
});

export function isAudioAttachment(attachment: InteractiveAttachment): boolean {
  return attachment.kind === "audio";
}

export function hasAudioAttachment(turn: InteractiveTurnInput): boolean {
  return turn.attachments.some(isAudioAttachment);
}

export function executionLaneKey(surfaceIdentity: string, chatKey: string): string {
  return JSON.stringify([surfaceIdentity, chatKey]);
}

export function abortVoiceIngressLane(lane: string): boolean {
  const scope = voiceScopes.get(lane);
  if (!scope || scope.state !== "preparing") return false;
  scope.state = "aborted";
  scope.controller.abort();
  voiceScopes.delete(lane);
  return true;
}

function beginVoiceIngressScope(turn: InteractiveTurnInput): VoiceIngressScope | null {
  const lane = executionLaneKey(turn.surfaceIdentity, turn.chatKey);
  const existing = voiceScopes.get(lane);
  if (existing?.state === "preparing") return null;
  const scope: VoiceIngressScope = { lane, controller: new AbortController(), state: "preparing" };
  voiceScopes.set(lane, scope);
  return scope;
}

function clearScope(scope: VoiceIngressScope): void {
  if (voiceScopes.get(scope.lane) === scope) voiceScopes.delete(scope.lane);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  const error = new Error("Voice ingress cancelled.");
  error.name = "AbortError";
  return error;
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function createVoiceOperationDir(root: string, maxTempBytes: number): Promise<string> {
  await mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(root, PRIVATE_DIR_MODE);
  const fs = await statfs(root);
  const available = Number(fs.bavail) * Number(fs.bsize);
  if (!Number.isFinite(available) || available < maxTempBytes) throw new Error("Voice transcription is unavailable: insufficient temporary disk space.");
  const operationDir = await mkdtemp(join(root, "voice-"));
  await chmod(operationDir, PRIVATE_DIR_MODE);
  return operationDir;
}

function combineCaptionAndTranscript(caption: string, transcript: string): string {
  const cleanCaption = caption.trim();
  const cleanTranscript = transcript.trim();
  return cleanCaption ? `${cleanCaption}\n\n[Voice note transcript]\n${cleanTranscript}` : cleanTranscript;
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function terminateProcessGroup(child: ChildProcess, graceMs = 500): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-pid, value); } catch { try { child.kill(value); } catch {} }
  };
  signal("SIGTERM");
  const escalateAt = Date.now() + graceMs;
  const giveUpAt = escalateAt + 1000;
  let escalated = false;
  await new Promise<void>((done) => {
    const poll = () => {
      try { process.kill(-pid, 0); }
      catch { done(); return; }
      const now = Date.now();
      if (!escalated && now >= escalateAt) { escalated = true; signal("SIGKILL"); }
      if (now >= giveUpAt) { done(); return; }
      const timer = setTimeout(poll, 25);
      timer.unref();
    };
    poll();
  });
}

async function runBoundedProcess(
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal.aborted) throw abortError();
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let pendingError: Error | null = null;
    let termination: Promise<void> | null = null;
    let settled = false;

    const failAndTerminate = (error: Error) => {
      if (pendingError || settled) return;
      pendingError = error;
      termination = terminateProcessGroup(child);
    };
    const onAbort = () => failAndTerminate(abortError());
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => failAndTerminate(new Error(`Voice helper timed out after ${options.timeoutMs}ms.`)), options.timeoutMs);
    timer.unref();

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > PROCESS_OUTPUT_LIMIT) {
        failAndTerminate(new Error("Voice helper exceeded its output limit."));
        return;
      }
      if (target === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => failAndTerminate(error));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      const finish = async () => {
        if (termination) await termination;
        if (pendingError) throw pendingError;
        if (signal || code !== 0) throw new Error(`Voice helper failed (${signal ?? `exit ${code}`}): ${stderr.trim().slice(-1000) || "no diagnostic output"}`);
        return { stdout, stderr };
      };
      finish().then(resolveProcess, rejectProcess);
    });
  });
}

interface VoiceRuntimeManifest {
  schemaVersion: number;
  whisperRelease: string;
  whisperSourceCommit: string;
  whisperArchiveSha256: string;
  whisperExecutable: string;
  whisperExecutableSha256: string;
  model: string;
  modelSha256: string;
  ffmpegPackageVersion: string;
}

export interface WhisperCppPaths {
  componentRoot?: string;
  manifestPath?: string;
  modelPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  nicePath?: string;
}

function whisperRuntimePaths(overrides: WhisperCppPaths = {}) {
  const componentRoot = overrides.componentRoot ?? DEFAULT_COMPONENT_ROOT;
  return {
    componentRoot,
    manifestPath: overrides.manifestPath ?? DEFAULT_MANIFEST_PATH,
    modelPath: overrides.modelPath ?? DEFAULT_MODEL_PATH,
    ffmpegPath: overrides.ffmpegPath ?? "/usr/bin/ffmpeg",
    ffprobePath: overrides.ffprobePath ?? "/usr/bin/ffprobe",
    nicePath: overrides.nicePath ?? "/usr/bin/nice",
  };
}

const preflightCache = new Map<string, Promise<{ whisperPath: string; modelPath: string; ffmpegPath: string; ffprobePath: string; nicePath: string }>>();

async function preflightWhisperRuntime(overrides: WhisperCppPaths = {}) {
  const paths = whisperRuntimePaths(overrides);
  const cacheKey = JSON.stringify(paths);
  const cached = preflightCache.get(cacheKey);
  if (cached) return cached;
  const check = (async () => {
    const raw = await readFile(paths.manifestPath, "utf8").catch(() => { throw new Error("Voice transcription runtime manifest is missing."); });
    const manifest = JSON.parse(raw) as VoiceRuntimeManifest;
    if (
      manifest.schemaVersion !== 1
      || manifest.whisperRelease !== WHISPER_CPP_RELEASE
      || manifest.whisperSourceCommit !== WHISPER_CPP_SOURCE_COMMIT
      || manifest.whisperArchiveSha256 !== WHISPER_CPP_UBUNTU_X64_ARCHIVE_SHA256
      || manifest.model !== WHISPER_CPP_MODEL_NAME
      || manifest.modelSha256 !== WHISPER_CPP_MODEL_SHA256
      || manifest.ffmpegPackageVersion !== PINNED_FFMPEG_PACKAGE_VERSION
    ) throw new Error("Voice transcription runtime manifest does not match the pinned component contract.");
    const whisperPath = resolve(paths.componentRoot, manifest.whisperExecutable);
    if (!isPathInside(paths.componentRoot, whisperPath)) throw new Error("Voice transcription runtime manifest contains an unsafe executable path.");
    for (const candidate of [whisperPath, paths.modelPath, paths.ffmpegPath, paths.ffprobePath, paths.nicePath]) {
      const info = await stat(candidate).catch(() => null);
      if (!info?.isFile()) throw new Error(`Voice transcription runtime asset is missing: ${candidate}`);
      if ((candidate === whisperPath || candidate === paths.modelPath) && (info.mode & 0o022) !== 0) throw new Error(`Voice transcription runtime asset is writable by group/world: ${candidate}`);
    }
    const [executableHash, modelHash] = await Promise.all([sha256File(whisperPath), sha256File(paths.modelPath)]);
    if (executableHash !== manifest.whisperExecutableSha256) throw new Error("Voice transcription executable checksum mismatch.");
    if (modelHash !== WHISPER_CPP_MODEL_SHA256) throw new Error("Voice transcription model checksum mismatch.");
    return { whisperPath, modelPath: paths.modelPath, ffmpegPath: paths.ffmpegPath, ffprobePath: paths.ffprobePath, nicePath: paths.nicePath };
  })();
  preflightCache.set(cacheKey, check);
  try { return await check; }
  catch (error) { preflightCache.delete(cacheKey); throw error; }
}

export function createWhisperCppTranscriber(paths: WhisperCppPaths = {}): VoiceTranscriber {
  return {
    name: "whisper.cpp-base.en-q5_1",
    available: process.env.AGENT_BRIDGE_VOICE_TRANSCRIPTION !== "disabled",
    async transcribe(input) {
      if (input.signal.aborted) throw abortError();
      const runtime = await preflightWhisperRuntime(paths);
      const probe = await runBoundedProcess(runtime.nicePath, ["-n", "19", runtime.ffprobePath, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input.filePath], {
        cwd: input.operationDir,
        signal: input.signal,
        timeoutMs: DEFAULT_VOICE_CONVERSION_TIMEOUT_MS,
      });
      const duration = Number.parseFloat(probe.stdout.trim());
      if (!Number.isFinite(duration)) throw new Error("Could not determine voice-note duration.");
      if (duration > input.maxDurationSeconds) throw new Error(`Audio exceeds the ${input.maxDurationSeconds}-second processing limit.`);

      const wavPath = join(input.operationDir, "normalized.wav");
      await runBoundedProcess(runtime.nicePath, ["-n", "19", runtime.ffmpegPath, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input.filePath, "-ac", "1", "-ar", "16000", "-f", "wav", wavPath], {
        cwd: input.operationDir,
        signal: input.signal,
        timeoutMs: DEFAULT_VOICE_CONVERSION_TIMEOUT_MS,
      });
      const wavInfo = await stat(wavPath);
      if (wavInfo.size > DEFAULT_VOICE_TEMP_BYTES) throw new Error("Normalized audio exceeds the voice temporary-storage limit.");

      const outputPrefix = join(input.operationDir, `transcript-${randomUUID()}`);
      await runBoundedProcess(runtime.nicePath, [
        "-n", "19", runtime.whisperPath,
        "-m", runtime.modelPath,
        "-f", wavPath,
        "-t", "1",
        "-p", "1",
        "-bs", "1",
        "-bo", "1",
        "-l", "en",
        "-np",
        "-otxt",
        "-of", outputPrefix,
      ], {
        cwd: input.operationDir,
        signal: input.signal,
        timeoutMs: DEFAULT_VOICE_TRANSCRIPTION_TIMEOUT_MS,
      });
      if (input.signal.aborted) throw abortError();
      const text = (await readFile(`${outputPrefix}.txt`, "utf8")).trim();
      if (!text) throw new Error("Voice transcription returned no text.");
      return { text };
    },
  };
}

function telegramTokenForSurface(surfaceIdentity: string): string | null {
  const suffix = surfaceIdentity.split(":", 2)[1]?.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!suffix) return null;
  return process.env[`TELEGRAM_BOT_TOKEN_${suffix}`]?.trim() || null;
}

async function fetchWithTimeout(url: string, init: RequestInit, parentSignal: AbortSignal, timeoutMs: number): Promise<Response> {
  if (parentSignal.aborted) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  catch (error) { if (parentSignal.aborted) throw abortError(); throw error; }
  finally { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); }
}

async function writeResponseBounded(response: Response, path: string, maxBytes: number, signal: AbortSignal): Promise<void> {
  if (!response.ok) throw new Error(`Voice attachment download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Audio exceeds the ${maxBytes}-byte processing limit.`);
  const handle = await open(path, "wx", PRIVATE_FILE_MODE);
  let total = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Voice attachment response had no body.");
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error(`Audio exceeds the ${maxBytes}-byte processing limit.`); }
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
}

async function stageTelegramAudio(input: Parameters<VoiceAudioStager["stage"]>[0]): Promise<string> {
  const token = telegramTokenForSurface(input.surfaceIdentity);
  if (!token) throw new Error("Voice transcription cannot resolve the Telegram surface credential.");
  const fileInfo = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(input.attachment.fileId)}`, {}, input.signal, DEFAULT_VOICE_DOWNLOAD_TIMEOUT_MS);
  if (!fileInfo.ok) throw new Error(`Telegram getFile failed with HTTP ${fileInfo.status}.`);
  const payload = await fileInfo.json() as any;
  const remotePath = String(payload?.result?.file_path ?? "");
  if (!remotePath) throw new Error("Telegram did not return a voice attachment path.");
  const destination = join(input.operationDir, "source-audio");
  const response = await fetchWithTimeout(`https://api.telegram.org/file/bot${token}/${remotePath}`, {}, input.signal, DEFAULT_VOICE_DOWNLOAD_TIMEOUT_MS);
  await writeResponseBounded(response, destination, input.maxAudioBytes, input.signal);
  return destination;
}

function trustedDiscordAttachmentUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === "cdn.discordapp.com" || host === "media.discordapp.net" || host.endsWith(".discordapp.com") || host.endsWith(".discordapp.net"))) {
    throw new Error("Discord voice attachment URL is not a trusted CDN location.");
  }
  return url;
}

async function stageDiscordAudio(input: Parameters<VoiceAudioStager["stage"]>[0]): Promise<string> {
  if (!input.attachment.remoteUrl) throw new Error("Discord voice attachment is missing its download URL.");
  const url = trustedDiscordAttachmentUrl(input.attachment.remoteUrl);
  const response = await fetchWithTimeout(url.toString(), {}, input.signal, DEFAULT_VOICE_DOWNLOAD_TIMEOUT_MS);
  const destination = join(input.operationDir, "source-audio");
  await writeResponseBounded(response, destination, input.maxAudioBytes, input.signal);
  return destination;
}

export const surfaceVoiceAudioStager: VoiceAudioStager = {
  async stage(input): Promise<string> {
    if (input.signal.aborted) throw abortError();
    if (input.surfaceIdentity.startsWith("telegram:")) return stageTelegramAudio(input);
    if (input.surfaceIdentity.startsWith("discord:")) return stageDiscordAudio(input);
    throw new Error(`Voice transcription is unsupported on surface ${input.surfaceIdentity}.`);
  },
};

async function notifyVoiceFailure(turn: InteractiveTurnInput, message: string): Promise<void> {
  try {
    if (turn.surfaceIdentity.startsWith("telegram:")) {
      const token = telegramTokenForSurface(turn.surfaceIdentity);
      if (!token) throw new Error("Telegram surface credential unavailable");
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: turn.delivery.chatId, text: message, ...(turn.threadId ? { message_thread_id: turn.threadId } : {}) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    }
    if (turn.surfaceIdentity.startsWith("discord:")) {
      const token = process.env.DISCORD_BOT_TOKEN?.trim();
      if (!token) throw new Error("Discord surface credential unavailable");
      const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(String(turn.delivery.chatId))}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error("[voice-ingress] failed to publish transcription error", error);
  }
}

export async function prepareVoiceTurn(turn: InteractiveTurnInput, options: PrepareVoiceTurnOptions): Promise<VoicePreparationResult> {
  const audio = turn.attachments.filter(isAudioAttachment);
  if (audio.length === 0) return { kind: "ready", turn };
  if (audio.length > 1) return { kind: "failed", error: new Error("Only one audio attachment is supported per turn.") };
  if (!options.transcriber.available) return { kind: "unavailable", reason: "Voice-note transcription is unavailable on this runtime." };
  if (options.signal.aborted) return { kind: "cancelled" };

  const attachment = audio[0];
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_AUDIO_DURATION_SECONDS;
  const maxTempBytes = options.maxTempBytes ?? DEFAULT_VOICE_TEMP_BYTES;
  if (attachment.fileSize !== undefined && (!Number.isFinite(attachment.fileSize) || attachment.fileSize < 0 || attachment.fileSize > maxAudioBytes)) {
    return { kind: "failed", error: new Error(`Audio exceeds the ${maxAudioBytes}-byte processing limit.`) };
  }
  if (attachment.durationSeconds !== undefined && (!Number.isFinite(attachment.durationSeconds) || attachment.durationSeconds < 0 || attachment.durationSeconds > maxDurationSeconds)) {
    return { kind: "failed", error: new Error(`Audio exceeds the ${maxDurationSeconds}-second processing limit.`) };
  }

  let operationDir: string | null = null;
  try {
    operationDir = await createVoiceOperationDir(options.tempRoot ?? DEFAULT_VOICE_TEMP_ROOT, maxTempBytes);
    if (options.signal.aborted) return { kind: "cancelled" };
    const filePath = await options.stager.stage({ attachment, operationDir, surfaceIdentity: turn.surfaceIdentity, signal: options.signal, maxAudioBytes });
    if (options.signal.aborted) return { kind: "cancelled" };
    if (!isPathInside(operationDir, filePath)) throw new Error("Voice media stager returned a path outside its operation directory.");
    const staged = await lstat(filePath);
    if (staged.isSymbolicLink() || !staged.isFile()) throw new Error("Staged voice media is not a regular file.");
    if (staged.size > maxAudioBytes) throw new Error(`Audio exceeds the ${maxAudioBytes}-byte processing limit.`);

    const result = await options.transcriber.transcribe({
      filePath,
      operationDir,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      signal: options.signal,
      maxDurationSeconds,
    });
    if (options.signal.aborted) return { kind: "cancelled" };
    const transcript = result.text.trim();
    if (!transcript) throw new Error("Voice transcription returned no text.");
    return {
      kind: "ready",
      turn: {
        ...turn,
        text: combineCaptionAndTranscript(turn.text, transcript),
        attachments: turn.attachments.filter((item) => item !== attachment),
      },
    };
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) return { kind: "cancelled" };
    return { kind: "failed", error: asError(error) };
  } finally {
    if (operationDir) await rm(operationDir, { recursive: true, force: true });
  }
}

const productionTranscriber = createWhisperCppTranscriber();

export async function prepareVoiceBatchForDispatch(turns: InteractiveTurnInput[], options: PrepareVoiceBatchOptions = {}): Promise<VoiceBatchPreparation> {
  const audioTurns = turns.filter(hasAudioAttachment);
  if (audioTurns.length === 0) return { kind: "ready", turns, handoff: async (operation) => { await operation(); } };
  const primary = audioTurns[0];
  const notify = options.notify ?? notifyVoiceFailure;
  if (audioTurns.length !== 1 || primary.attachments.filter(isAudioAttachment).length !== 1) {
    await notify(primary, "Could not transcribe this message: send one voice/audio attachment at a time.");
    return { kind: "drop" };
  }
  const scope = beginVoiceIngressScope(primary);
  if (!scope) {
    await notify(primary, "A voice transcription is already running in this conversation. Use /stop or wait for it to finish.");
    return { kind: "drop" };
  }
  const result = await prepareVoiceTurn(primary, {
    transcriber: options.transcriber ?? productionTranscriber,
    stager: options.stager ?? surfaceVoiceAudioStager,
    signal: scope.controller.signal,
    ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
    ...(options.maxAudioBytes === undefined ? {} : { maxAudioBytes: options.maxAudioBytes }),
    ...(options.maxDurationSeconds === undefined ? {} : { maxDurationSeconds: options.maxDurationSeconds }),
    ...(options.maxTempBytes === undefined ? {} : { maxTempBytes: options.maxTempBytes }),
  });
  if (result.kind === "cancelled" || scope.state === "aborted") { clearScope(scope); return { kind: "drop" }; }
  if (result.kind === "unavailable") {
    clearScope(scope);
    await notify(primary, `Could not transcribe this voice note: ${result.reason}`);
    return { kind: "drop" };
  }
  if (result.kind === "failed") {
    clearScope(scope);
    await notify(primary, `Could not transcribe this voice note: ${result.error.message}`);
    return { kind: "drop" };
  }
  const preparedTurns = turns.map((turn) => turn === primary ? result.turn : turn);
  return {
    kind: "ready",
    turns: preparedTurns,
    handoff: async (operation) => {
      if (scope.state !== "preparing" || scope.controller.signal.aborted) { clearScope(scope); return; }
      scope.state = "handed-off";
      clearScope(scope);
      await operation();
    },
  };
}

/** Remove only stale, direct, managed `voice-*` directories. Symlinks are never followed. */
export async function reapStaleVoiceTempDirs(root: string = DEFAULT_VOICE_TEMP_ROOT, options: { nowMs?: number; staleAfterMs?: number } = {}): Promise<number> {
  await mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_VOICE_STALE_AFTER_MS;
  let removed = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("voice-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(root, entry.name);
    const info = await lstat(candidate).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    if (nowMs - info.mtimeMs < staleAfterMs) continue;
    await rm(candidate, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
