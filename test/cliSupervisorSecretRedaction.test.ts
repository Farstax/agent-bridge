import { afterEach, describe, expect, it, vi } from "vitest";
import { runSupervisedProcess, shutdownCliProcessesAndWait } from "../src/cliSupervisor.js";
import { createStreamingSecretRedactor } from "../src/providers/streamingSecretRedactor.js";
import type { BridgeEvent } from "../src/events/types.js";

afterEach(async () => {
  await shutdownCliProcessesAndWait();
  vi.restoreAllMocks();
});

describe("provider credential redaction", () => {
  it("redacts a secret split across arbitrary stream chunks", () => {
    const secret = "provider-secret-572-do-not-leak";
    const redactor = createStreamingSecretRedactor([secret]);
    const output = [
      redactor.push("before provider-sec"),
      redactor.push("ret-572-do-"),
      redactor.push("not-leak after"),
      redactor.flush(),
    ].join("");

    expect(output).toBe("before [REDACTED_PROVIDER_CREDENTIAL] after");
    expect(output).not.toContain(secret);
  });

  it("keeps split API keys out of logs, events, progress, and failures", async () => {
    const apiKey = "provider-secret-572-do-not-leak";
    const logs: string[] = [];
    const events: BridgeEvent[] = [];
    const progress: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));

    const splitAt = 13;
    const script = [
      `const key=process.env.CODEX_API_KEY;const n=${splitAt};`,
      'process.stdout.write("stdout=" + key.slice(0,n));',
      'process.stderr.write("stderr=" + key.slice(0,n));',
      'setTimeout(()=>{process.stdout.write(key.slice(n)+"\\n");process.stderr.write(key.slice(n)+"\\n");setTimeout(()=>process.exit(1),10);},20);',
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
    expect(progress.join("")).not.toContain(apiKey);
  });
});
