import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { isHandoffRequired, markHandoffRequired } from "../src/handoffState.js";

const FALLBACK_NOTE = "The previous provider became unavailable while working on this same user action.";

function makeEngine(db: ReturnType<typeof openDb>, kind: "claude" | "antigravity") {
  return new BridgeEngine(
    {
      surfaceIdentity: "telegram:interactive",
      kind,
      botConfig: { command: kind === "antigravity" ? "agy" : kind, modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workspaceContext: null,
    },
    db,
    {} as any,
  );
}

async function buildPrompt(
  engine: BridgeEngine,
  nativeSessionMode: "fresh" | "resume",
  prompt = "continue this action",
): Promise<string> {
  return (await (engine as any)._buildPromptForCli("100", prompt, nativeSessionMode, null)).prompt;
}

describe("Issue #637 provider fallback continuation intent", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("tells Claude to continue the same action after Codex fallback without inventing a conversation turn", async () => {
    markHandoffRequired(db, "100", "claude", "fallback_from_codex");

    const prompt = await buildPrompt(makeEngine(db, "claude"), "fresh");

    expect(prompt).toContain(FALLBACK_NOTE);
    expect(prompt).toContain("inspect the repository, worktree and generated artifacts");
    expect(prompt).toContain("continue this action");
    expect(db.getConvStatus("100", "telegram:interactive").turnCount).toBe(0);
  });

  it("tells the next Agy provider to continue after Claude fallback", async () => {
    markHandoffRequired(db, "100", "antigravity", "fallback_from_claude");

    const prompt = await buildPrompt(makeEngine(db, "antigravity"), "fresh");

    expect(prompt).toContain(FALLBACK_NOTE);
    expect(prompt).toContain("preserve valid existing work");
  });

  it("does not imply interrupted work for a manual provider switch", async () => {
    markHandoffRequired(db, "100", "claude", "manual_switch");

    const prompt = await buildPrompt(makeEngine(db, "claude"), "fresh");

    expect(prompt).toContain("[Agent Bridge handoff]");
    expect(prompt).not.toContain(FALLBACK_NOTE);
  });

  it("keeps ordinary fresh and resumed sessions free of fallback-specific guidance", async () => {
    const engine = makeEngine(db, "claude");

    expect(await buildPrompt(engine, "fresh")).not.toContain(FALLBACK_NOTE);
    markHandoffRequired(db, "100", "claude", "fallback_from_codex");
    expect(await buildPrompt(engine, "resume")).not.toContain(FALLBACK_NOTE);
  });

  it("keeps the durable fallback marker until a successful fresh provider result owns clearing it", () => {
    markHandoffRequired(db, "100", "claude", "fallback_from_codex");
    expect(isHandoffRequired(db, "100", "claude")).toBe(true);
  });
});
