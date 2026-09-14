import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult, runCli } from "../src/cli.js";
import { validateSuccessfulCliExit } from "../src/cliSuccessfulExitValidation.js";
import type { BridgeEvent } from "../src/events/types.js";

const CURSOR_SESSION = "cursor-session-575";

function terminalEvents(events: BridgeEvent[]): BridgeEvent[] {
  return events.filter((event) =>
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

async function providerFixture(
  root: string,
  provider: "cursor",
  sessionId: string,
): Promise<string> {
  const script = join(root, `${provider}-fixture`);
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const sessionId = ${JSON.stringify(sessionId)};
const args = process.argv.slice(2);
const root = process.cwd();
const resumed = args.includes("--resume");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (!resumed) {
  fs.appendFileSync(path.join(root, "side-effects.txt"), "effect\\n");
  emit({ type: "assistant", session_id: sessionId, message: "SECRET_INTERNAL_MESSAGE" });
  process.exit(0);
}
fs.writeFileSync(path.join(root, "recovery-args.json"), JSON.stringify(args));
emit({ type: "result", subtype: "success", is_error: false, result: "verified final answer", session_id: sessionId });
`;
  await writeFile(script, source, { mode: 0o700 });
  return script;
}

describe("provider uncertain completion contract", () => {
  it("rejects exit-zero Cursor output without a terminal result before run.completed", () => {
    const error = validateSuccessfulCliExit("cursor", {
      stdout: `${JSON.stringify({ type: "assistant", session_id: CURSOR_SESSION, message: "internal" })}\n`,
      stderr: "",
    });
    expect(error?.message).toMatch(/completion could not be verified/i);
  });

  it("reconciles cursor exactly once in the same native session without replaying side effects", async () => {
    const provider = "cursor" as const;
    const bot = "cursor" as const;
    const sessionId = CURSOR_SESSION;
    const outputFormat = "stream-json" as const;
    const root = await mkdtemp(join(tmpdir(), `provider-uncertain-${provider}-`));
    const homeDir = join(root, "home");
    const events: BridgeEvent[] = [];
    try {
      const command = await providerFixture(root, provider, sessionId);
      const invocation = buildCliInvocation({
        bot,
        prompt: "perform one side effect",
        sessionId: null,
        command,
        model: null,
        outputFormat,
        homeDir,
        effort: null,
      });
      const stdout = await runCli(command, invocation.args, root, {
        bot,
        bypassWorkspaceLock: true,
        eventContext: { runId: `uncertain-${provider}`, bot, chatId: "chat:575" },
        onEvent: (event) => events.push(event),
      });

      expect(parseCliResult({ bot, stdout, outputFormat }).text).toBe("verified final answer");
      expect(await readFile(join(root, "side-effects.txt"), "utf8")).toBe("effect\n");
      const recoveryArgs = JSON.parse(await readFile(join(root, "recovery-args.json"), "utf8")) as string[];
      expect(recoveryArgs).toContain(sessionId);
      expect(recoveryArgs.join(" ")).toMatch(/Do not repeat side effects/i);
      expect(stdout).not.toContain("SECRET_INTERNAL_MESSAGE");
      expect(terminalEvents(events).map((event) => event.type)).toEqual(["run.completed"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
