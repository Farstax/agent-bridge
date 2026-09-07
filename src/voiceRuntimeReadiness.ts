import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  PINNED_FFMPEG_PACKAGE_VERSION,
  WHISPER_CPP_MODEL_NAME,
  WHISPER_CPP_MODEL_SHA256,
  WHISPER_CPP_RELEASE,
  WHISPER_CPP_SOURCE_COMMIT,
  WHISPER_CPP_UBUNTU_X64_ARCHIVE_SHA256,
} from "./voiceIngress.js";

type Env = Record<string, string | undefined>;

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

export interface VoiceRuntimeReadiness {
  status: "ready" | "unavailable";
  reasonCode: string | null;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}

function regularSafe(path: string, executable = false): boolean {
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) return false;
  if (executable) accessSync(path, constants.X_OK);
  return true;
}

export function inspectVoiceRuntimeReadiness(env: Env = process.env): VoiceRuntimeReadiness {
  if (env.AGENT_BRIDGE_VOICE_TRANSCRIPTION === "disabled") {
    return { status: "unavailable", reasonCode: "voice_transcription_disabled" };
  }
  try {
    const root = env.AGENT_BRIDGE_STT_ROOT?.trim() || "/opt/agent-bridge/host-components/voice-stt";
    const current = join(root, "current");
    const currentInfo = lstatSync(current);
    if (!currentInfo.isSymbolicLink()) throw new Error("current pointer is not a symlink");
    const target = readlinkSync(current);
    if (!target.startsWith("components/") || target.includes("..") || isAbsolute(target)) throw new Error("current pointer is unsafe");
    const componentRoot = resolve(root, target);
    if (!inside(root, componentRoot)) throw new Error("component root escaped STT root");
    const manifestPath = join(componentRoot, "manifest.json");
    if (!regularSafe(manifestPath)) throw new Error("component manifest is not a safe regular file");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as VoiceRuntimeManifest;
    if (
      manifest.schemaVersion !== 1
      || manifest.whisperRelease !== WHISPER_CPP_RELEASE
      || manifest.whisperSourceCommit !== WHISPER_CPP_SOURCE_COMMIT
      || manifest.whisperArchiveSha256 !== WHISPER_CPP_UBUNTU_X64_ARCHIVE_SHA256
      || manifest.model !== WHISPER_CPP_MODEL_NAME
      || manifest.modelSha256 !== WHISPER_CPP_MODEL_SHA256
      || manifest.ffmpegPackageVersion !== PINNED_FFMPEG_PACKAGE_VERSION
      || typeof manifest.whisperExecutable !== "string"
      || typeof manifest.whisperExecutableSha256 !== "string"
    ) throw new Error("component manifest identity mismatch");

    const whisper = resolve(componentRoot, manifest.whisperExecutable);
    if (!inside(componentRoot, whisper) || !regularSafe(whisper, true)) throw new Error("whisper executable is unavailable");
    const model = join(root, "models", WHISPER_CPP_MODEL_NAME);
    if (!regularSafe(model)) throw new Error("voice model is unavailable");
    for (const binary of ["/usr/bin/ffmpeg", "/usr/bin/ffprobe"]) {
      const info = statSync(binary);
      if (!info.isFile()) throw new Error(`${binary} is unavailable`);
      accessSync(binary, constants.X_OK);
    }
    if (hashFile(whisper) !== manifest.whisperExecutableSha256) throw new Error("whisper checksum mismatch");
    if (hashFile(model) !== WHISPER_CPP_MODEL_SHA256) throw new Error("model checksum mismatch");
    return { status: "ready", reasonCode: null };
  } catch {
    return { status: "unavailable", reasonCode: "voice_runtime_preflight_failed" };
  }
}
