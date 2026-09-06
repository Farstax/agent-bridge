import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { shutdownCliProcessesAndWait } from "../src/cli.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import type { TelegramMessage } from "../src/types.js";

const HARNESS_KIND = process.env.BRIDGE_STOP_PREVIEW_KIND === "antigravity" ? "antigravity" : "claude";
const WATCHDOG_MS = 5_000;

function makeMessage(text: string, userId = 42, chatId = 100): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, first_name: "Test" },
    text,
  };
}

function claudeResult(text: string, sessionId: string): string {
  return `${JSON.stringify({ type: "result", result: text, session_id: sessionId })}\n`;
}

function claudeDelta(text: string): string {
  return `${JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  })}\n`;
}

function agyResult(text: string, sessionId: string): string {
  return `${JSON.stringify({ event: "result", result: { conversation_id: sessionId, status: "SUCCESS", response: text } })}\n`;
}

function agyDelta(text: string): string {
  return `${JSON.stringify({
    event: "step_update",
    step_update: { step_type: "agent_response", text_delta: text },
  })}\n`;
}

async function runEngineStopPreviewScenario(kind: "claude" | "antigravity"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `stop-preview-${kind}-`));
  process.env.HOME = root;
  const dbPath = join(root, "signal.db");
  const db = openDb(dbPath);
  let releasePreview!: (value: unknown) => void;
  const previewHang = new Promise((resolve) => { releasePreview = resolve; });
  let previewStarted!: () => void;
  const previewStartedPromise = new Promise<void>((resolve) => { previewStarted = resolve; });
  let phase: "preview" | "later" = "preview";
  const sentTexts: string[] = [];
  const client = {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    sendMessage: async (body: { text?: string }) => {
      const text = String(body.text ?? "");
      sentTexts.push(text);
      if (text.includes("aborted") || phase === "later") {
        return { ok: true, result: { message_id: sentTexts.length } };
      }
      previewStarted();
      await previewHang;
      return { ok: true, result: { message_id: 456 } };
    },
    sendChatAction: async () => ({ ok: true, result: true }),
    editMessageText: async () => ({ ok: true, result: true }),
    deleteMessage: async () => ({ ok: true, result: true }),
    sendPhoto: async () => undefined,
    sendDocument: async () => undefined,
    getUpdates: async () => ({ ok: true, result: [] }),
    setMyCommands: async () => ({ ok: true }),
    answerCallbackQuery: async () => ({ ok: true }),
  };

  const engine = new BridgeEngine(
    {
      surfaceIdentity: "telegram:interactive",
      kind,
      botConfig: { command: kind === "antigravity" ? "agy" : kind, modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "queue",
      pollIntervalMs: 1000,
      workingDir: root,
    },
    db,
    client as any,
    {
      runCliAsync: async (_command, _args, _cwd, options) => {
        if (phase === "later") {
          return {
            text: kind === "claude"
              ? claudeResult("later turn ok", "s-later")
              : agyResult("later turn ok", "11111111-1111-4111-8111-111111111111"),
          };
        }
        options?.onProviderOutputChunk?.(kind === "claude" ? claudeDelta("preview in flight") : agyDelta("preview in flight"));
        return {
          text: kind === "claude"
            ? claudeResult("must not be delivered", "s-preview")
            : agyResult("must not be delivered", "11111111-1111-4111-8111-111111111112"),
        };
      },
    },
  );

  try {
    const firstTurn = engine.handleMessages([makeMessage("start preview")]);
    await previewStartedPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await engine.handleUpdate({ update_id: 2, message: makeMessage("/stop") });

    const settled = await firstTurn;
    void settled;
    expect(sentTexts.some((text) => text.includes("aborted"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("must not be delivered"))).toBe(false);
    expect(db.getSession("100", kind)).toBeNull();

    releasePreview({ ok: true });
    phase = "later";
    await engine.handleMessages([makeMessage("next turn")]);
    expect(sentTexts.some((text) => text.includes("later turn ok"))).toBe(true);
    expect(db.getSession("100", kind)).toBeTruthy();
  } finally {
    releasePreview({ ok: true });
    await shutdownCliProcessesAndWait();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.env.BRIDGE_STOP_PREVIEW_HARNESS === "1") {
  runEngineStopPreviewScenario(HARNESS_KIND).then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
} else {
  describe("engine /stop during pending answer preview", () => {
    afterEach(async () => {
      await shutdownCliProcessesAndWait();
    });

    for (const kind of ["claude", "antigravity"] as const) {
      it(`settles ${kind} /stop after deliverFinal preview wait without spinning the event loop`, async () => {
        const tsxCli = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "tsx", "dist", "cli.mjs");
        const childEnv = { ...process.env };
        for (const key of Object.keys(childEnv)) {
          if (key === "VITEST" || key.startsWith("VITEST_") || key.startsWith("VITEST_POOL_")) {
            delete childEnv[key];
          }
        }
        const child = spawn(process.execPath, [tsxCli, fileURLToPath(import.meta.url)], {
          env: {
            ...childEnv,
            BRIDGE_STOP_PREVIEW_HARNESS: "1",
            BRIDGE_STOP_PREVIEW_KIND: kind,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ code: null, signal: "SIGKILL" });
          }, WATCHDOG_MS);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        });
        if (result.code !== 0 || result.signal) {
          throw new Error(`watchdog child failed code=${result.code} signal=${result.signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }
      }, WATCHDOG_MS + 2_000);
    }
  });
}
