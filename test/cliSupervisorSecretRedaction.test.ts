import { afterEach, describe, expect, it, vi } from "vitest";
import { runSupervisedProcess, shutdownCliProcessesAndWait } from "../src/cliSupervisor.js";
import type { BridgeEvent } from "../src/events/types.js";

afterEach(async () => {
  await shutdownCliProcessesAndWait();
  vi.restoreAllMocks();
});

describe("provider credential redaction", () => {
  it("keeps echoed API keys out of logs, events, progress, and failures", async () => {
    const apiKey = "provider-secret-572-do-not-leak";
    const logs: string[] = [];
    const events: BridgeEvent[] = [];
    const progress: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));

    const script = [
      'process.stdout.write("stdout=" + process.env.CODEX_API_KEY + "\\n");',
      'process.stderr.write("stderr=" + process.env.CODEX_API_KEY + "\\n");',
      "process.exit(1);",
    ].join("");

    let failure: (Error & { stdout?: string; stderr?: string }) | null = null;
    try {
      await runSupervisedProcess(process.execPath, ["-e", script], process.cwd(), {
        contextEnv: { CODEX_API_KEY: apiKey },
        bot: "codex",
        eventContext: { runId: "run-572", bot: "codex", chatId: "1", chatKey: "1" },
        onEvent: (event) => events.push(event),
      }, (chunk) => progress.push(chunk));
    } catch (error) {
      failure = error as Error & { stdout?: string; stderr?: string };
    }

    expect(failure).not.toBeNull();
    const exposedSurface = JSON.stringify({
      logs,
      events,
      progress,
      message: failure?.message,
      stdout: failure?.stdout,
      stderr: failure?.stderr,
    });
    expect(exposedSurface).not.toContain(apiKey);
    expect(exposedSurface).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
  });
});
