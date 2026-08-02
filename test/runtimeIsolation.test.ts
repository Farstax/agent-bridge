import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult, runCli, setAntigravityModel } from "../src/cli.js";
import { downloadTelegramAttachment } from "../src/fileDownload.js";
import { prepareOutputDir, cleanOutputDir } from "../src/fileOutput.js";
import { withAntigravityStateLock } from "../src/providers/antigravityRuntime.js";
import { runAntigravitySerialized } from "../src/providers/antigravitySerializedRunner.js";
import type { TelegramMessage } from "../src/types.js";

function permissionBits(mode: number): number {
  return mode & 0o777;
}

describe("runtime isolation", () => {
  it("creates run output directories with owner-only permissions", async () => {
    const dir = await prepareOutputDir(`permissions-${Date.now()}`, "claude", "run");
    try {
      expect(permissionBits((await stat(dir)).mode)).toBe(0o700);
    } finally {
      await cleanOutputDir(dir);
    }
  });

  it("creates attachment directories with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-attachment-permissions-"));
    const dest = join(root, "incoming");
    await mkdir(dest, { mode: 0o777 });
    await chmod(dest, 0o777);
    const message: TelegramMessage = {
      message_id: 1,
      chat: { id: 1, type: "private" },
      text: "no attachment",
    };
    try {
      await downloadTelegramAttachment({} as never, message, dest);
      expect(permissionBits((await stat(dest)).mode)).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes Antigravity shared-state operations", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agy-lock-home-"));
    let active = 0;
    let maxActive = 0;
    const run = (delayMs: number) => withAntigravityStateLock(homeDir, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
    });
    try {
      await Promise.all([run(80), run(10), run(10)]);
      expect(maxActive).toBe(1);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not let an out-of-band model update alter an active Antigravity operation", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agy-model-lock-home-"));
    const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    try {
      setAntigravityModel("gemini-3.5-flash-high", homeDir);
      await withAntigravityStateLock(homeDir, async () => {
        setAntigravityModel("gemini-3.5-flash-medium", homeDir);
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        expect(settings.model).toBe("Gemini 3.5 Flash (High)");
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves provider settings for direct Antigravity calls without invocation metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-direct-call-"));
    const homeDir = join(root, "home");
    const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    const script = join(root, "agy-fixture");
    await mkdir(join(homeDir, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ model: "Gemini 3.5 Flash (High)" }));
    await writeFile(script, "#!/usr/bin/env bash\nprintf '{\"response\":\"ok\"}\\n'\n", { mode: 0o700 });
    try {
      await runAntigravitySerialized(script, ["--print", "hello"], root, {
        bot: "antigravity",
        timeoutMs: 5_000,
        idleTimeoutMs: 5_000,
      }, { homeDir, model: null, applyModel: false });
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      expect(settings.model).toBe("Gemini 3.5 Flash (High)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the invocation model and reconciles the conversation before releasing the Antigravity lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-run-lock-"));
    const homeDir = join(root, "home");
    const logFile = join(root, "agy.log");
    const script = join(root, "agy-fixture");
    const conversationId = "11111111-2222-3333-4444-555555555555";
    await mkdir(homeDir, { recursive: true });
    await writeFile(script, `#!/usr/bin/env bash\nset -euo pipefail\nlog_file=\"\"\nwhile (( $# )); do\n  if [[ \"$1\" == \"--log-file\" ]]; then log_file=\"$2\"; shift 2; else shift; fi\ndone\nprintf 'Print mode: conversation=${conversationId}\\n' > \"$log_file\"\nprintf '{\"response\":\"ok\"}\\n'\n`, { mode: 0o700 });

    try {
      const invocation = buildCliInvocation({
        bot: "antigravity",
        command: script,
        prompt: "hello",
        sessionId: null,
        model: "gemini-3.5-flash-high",
        logFile,
        homeDir,
      });
      const stdout = await runCli(invocation.command, invocation.args, root, {
        bot: "antigravity",
        timeoutMs: 5_000,
        idleTimeoutMs: 5_000,
      });
      const result = parseCliResult({ bot: "antigravity", stdout });
      const settings = JSON.parse(await readFile(join(homeDir, ".gemini", "antigravity-cli", "settings.json"), "utf8"));

      expect(settings.model).toBe("Gemini 3.5 Flash (High)");
      expect(result).toEqual({ text: "ok", sessionId: conversationId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
