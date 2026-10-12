#!/usr/bin/env node
/**
 * Explicit logical-message qualification. Stdout is one closed metadata record.
 * The fixed prompt never comes from argv, and the answer is not printed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runAcpProviderTurn } from "../src/providers/acpRuntime.js";
import { assertProviderId, getAcpProviderPolicy, resolveProviderExecutable } from "../src/providers/registry.js";
import type { ProviderId } from "../src/providers/types.js";
import type { RouteableBotKind } from "../src/types.js";
import {
  assertQualificationTraceOmits,
  buildLogicalMessageQualificationTrace,
  LogicalMessageQualificationLeak,
  type LogicalMessageQualificationTrace,
} from "../src/acp/logicalMessageQualification.js";

const PROMPT = "Reply with exactly the single word ready. Do not call tools.";

function providerArgument(argv: readonly string[]): string {
  let provider = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") provider = argv[index + 1] ?? "";
    else if (arg !== undefined && index > 0 && argv[index - 1] === "--provider") continue;
    else throw new Error("logical_message_qualification_unknown_argument");
  }
  if (!/^[a-z0-9-]{1,32}$/.test(provider)) throw new Error("logical_message_qualification_unknown_provider");
  return provider;
}

function botFor(provider: ProviderId): RouteableBotKind {
  if (provider === "agy") return "antigravity";
  return provider;
}

async function main(): Promise<void> {
  const providerId = assertProviderId(providerArgument(process.argv.slice(2)));
  const cwd = mkdtempSync(join(tmpdir(), "logical-message-qualification-"));
  try {
    const toolFree = getAcpProviderPolicy(providerId)?.toolFree === true;
    let answer = "";
    let trace: LogicalMessageQualificationTrace | undefined;
    const result = await runAcpProviderTurn(providerId, {
      prompt: PROMPT,
      sessionId: null,
      command: resolveProviderExecutable(providerId),
      model: null,
      executionMode: "safe",
      outputFormat: null,
      soulContext: null,
      includeResponseContract: false,
      attachments: [],
      outputDir: null,
      effort: null,
      toolMode: toolFree ? "none" : "default",
    }, cwd, {
      timeoutMs: 180_000,
      idleTimeoutMs: 90_000,
      bot: botFor(providerId),
      suppressTransientRetry: true,
    }, {
      conversationId: randomUUID(),
      runId: randomUUID(),
    }, (turn) => {
      answer = turn.liveText;
      trace = buildLogicalMessageQualificationTrace(providerId, turn);
    });
    if (!trace) throw new LogicalMessageQualificationLeak();
    assertQualificationTraceOmits(trace, [PROMPT, answer, result.text]);
    process.stdout.write(`${JSON.stringify(trace)}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "";
  const safe = message === "logical_message_qualification_retained_content"
    || message === "logical_message_qualification_unknown_argument"
    || message === "logical_message_qualification_unknown_provider"
    ? message
    : "logical_message_qualification_failed";
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
});
