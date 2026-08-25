import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeStructuredOutputMissingResultError,
  parseClaudeStreamJsonOutput,
} from "../src/claudeStreamJson.js";
import {
  ClaudeUncertainCompletionError,
  validateSuccessfulCliExit,
} from "../src/cliSuccessfulExitValidation.js";
import { runCli } from "../src/cli.js";
import {
  clearProviderApiKeyVerificationCache,
  verifyProviderApiKey,
} from "../src/providers/apiKeyAuth.js";
import type { BridgeEvent } from "../src/events/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearProviderApiKeyVerificationCache();
});

function claudeResult(text: string, sessionId = "sess-574"): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId });
}

function makeClaudeScript(body: string): { root: string; script: string; count: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-claude-uncertain-"));
  roots.push(root);
  const script = join(root, "claude-fixture");
  const count = join(root, "count");
  writeFileSync(script, `#!/usr/bin/env node\n${body.replace("__COUNT__", count)}\n`);
  chmodSync(script, 0o755);
  return { root, script, count };
}

function invocationArgs(): string[] {
  return ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "initial request"];
}

describe("Claude uncertain completion boundary", () => {
  it("fails closed when recognizable stream-json has no terminal result", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-partial" }),
      JSON.stringify({
        type: "stream_event",
        session_id: "sess-partial",
        event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "provider-secret-signature" } },
      }),
      JSON.stringify({ type: "assistant", session_id: "sess-partial", message: { content: [{ type: "thinking", thinking: "internal" }] } }),
      JSON.stringify({ type: "user", session_id: "sess-partial", message: { content: [{ type: "tool_result", content: "/private/worktree/path" }] } }),
    ].join("\n");

    try {
      parseClaudeStreamJsonOutput(stdout);
      throw new Error("expected structured Claude output without a result to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeStructuredOutputMissingResultError);
      expect((error as ClaudeStructuredOutputMissingResultError).sessionId).toBe("sess-partial");
      expect((error as Error).message).not.toContain("provider-secret-signature");
      expect((error as Error).message).not.toContain("/private/worktree/path");
    }
  });

  it("classifies the stderr background-task ceiling while preserving the safe result", () => {
    const stdout = claudeResult("Useful result before timeout.");
    const error = validateSuccessfulCliExit("claude", {
      stdout,
      stderr: "Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\n",
    });

    expect(error).toBeInstanceOf(ClaudeUncertainCompletionError);
    const claudeError = error as ClaudeUncertainCompletionError;
    expect(claudeError.reason).toBe("background-task-ceiling");
    expect(claudeError.sessionId).toBe("sess-574");
    expect(claudeError.safeResult?.text).toBe("Useful result before timeout.");
  });

  it("does not classify timeout wording quoted in user-visible stdout", () => {
    const error = validateSuccessfulCliExit("claude", {
      stdout: claudeResult("The log said: Background tasks still running after 600s; terminating."),
      stderr: "",
    });
    expect(error).toBeNull();
  });

  it("recovers once in the same Claude session and returns only the reconciled terminal result", async () => {
    const { root, script, count } = makeClaudeScript(`
const fs = require("node:fs");
const countPath = ${JSON.stringify("__COUNT__")};
let n = 0;
try { n = Number(fs.readFileSync(countPath, "utf8")); } catch {}
n += 1;
fs.writeFileSync(countPath, String(n));
if (n === 1) {
  console.log(${JSON.stringify(claudeResult("Useful partial result."))});
  console.error("Background tasks still running after 3s; terminating.");
} else {
  const resumeIndex = process.argv.indexOf("--resume");
  if (resumeIndex < 0 || process.argv[resumeIndex + 1] !== "sess-574") process.exit(9);
  console.log(${JSON.stringify(claudeResult("Recovered final closure."))});
}
`);
    const events: BridgeEvent[] = [];

    const stdout = await runCli(script, invocationArgs(), root, {
      bot: "claude",
      bypassWorkspaceLock: true,
      eventContext: { runId: "run-574", bot: "claude", chatId: "chat-574", chatKey: "chat-574" },
      onEvent: (event) => events.push(event),
    });

    expect(parseClaudeStreamJsonOutput(stdout)?.text).toBe("Recovered final closure.");
    expect(readFileSync(count, "utf8")).toBe("2");
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  });

  it("recovers partial structured output without exposing protocol records", async () => {
    const { root, script, count } = makeClaudeScript(`
const fs = require("node:fs");
const countPath = ${JSON.stringify("__COUNT__")};
let n = 0;
try { n = Number(fs.readFileSync(countPath, "utf8")); } catch {}
n += 1;
fs.writeFileSync(countPath, String(n));
if (n === 1) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-574" }));
  console.log(JSON.stringify({ type: "stream_event", session_id: "sess-574", event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "DO_NOT_EXPOSE" } } }));
  console.log(JSON.stringify({ type: "user", session_id: "sess-574", message: { content: [{ type: "tool_result", content: "/private/path" }] } }));
} else {
  console.log(${JSON.stringify(claudeResult("Reconciled after partial stream."))});
}
`);

    const stdout = await runCli(script, invocationArgs(), root, { bot: "claude", bypassWorkspaceLock: true });

    expect(parseClaudeStreamJsonOutput(stdout)?.text).toBe("Reconciled after partial stream.");
    expect(stdout).not.toContain("DO_NOT_EXPOSE");
    expect(stdout).not.toContain("/private/path");
    expect(readFileSync(count, "utf8")).toBe("2");
  });

  it("attempts recovery at most once and preserves a useful result when reconciliation remains uncertain", async () => {
    const { root, script, count } = makeClaudeScript(`
const fs = require("node:fs");
const countPath = ${JSON.stringify("__COUNT__")};
let n = 0;
try { n = Number(fs.readFileSync(countPath, "utf8")); } catch {}
n += 1;
fs.writeFileSync(countPath, String(n));
console.log(${JSON.stringify(claudeResult("Useful result that may be incomplete."))});
console.error("Background tasks still running after 3s; terminating.");
`);

    const stdout = await runCli(script, invocationArgs(), root, { bot: "claude", bypassWorkspaceLock: true });
    const parsed = parseClaudeStreamJsonOutput(stdout);

    expect(readFileSync(count, "utf8")).toBe("2");
    expect(parsed?.text).toContain("Useful result that may be incomplete.");
    expect(parsed?.text).toMatch(/completion could not be verified/i);
  });

  it("redacts provider keys from the recovered result and terminal event", async () => {
    const secret = "claude-recovery-secret-574";
    await verifyProviderApiKey("claude", { env: { ANTHROPIC_API_KEY: secret }, execFile: async () => undefined });
    const { root, script } = makeClaudeScript(`
console.log(${JSON.stringify(claudeResult("Recovered result with " + secret + "."))});
console.error("Background tasks still running after 3s; terminating.");
`);
    const events: BridgeEvent[] = [];

    const stdout = await runCli(script, invocationArgs(), root, {
      bot: "claude",
      contextEnv: { ANTHROPIC_API_KEY: secret },
      bypassWorkspaceLock: true,
      eventContext: { runId: "run-574-redact", bot: "claude", chatId: "chat-574", chatKey: "chat-574" },
      onEvent: (event) => events.push(event),
    });

    expect(stdout).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(stdout).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
  });

  it("does not suppress ordinary Claude CLI failures", async () => {
    const { root, script } = makeClaudeScript("process.exit(7);");
    const events: BridgeEvent[] = [];

    await expect(runCli(script, invocationArgs(), root, {
      bot: "claude",
      bypassWorkspaceLock: true,
      eventContext: { runId: "run-574-fail", bot: "claude", chatId: "chat-574", chatKey: "chat-574" },
      onEvent: (event) => events.push(event),
    })).rejects.toThrow(/exited with code 7/i);

    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });
});
