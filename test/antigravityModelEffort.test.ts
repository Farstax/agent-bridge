import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEffortArgs,
  getAgyEffortForArgs,
  resolveAgyModelForEffort,
} from "../src/effort.js";
import {
  DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE,
  loadBotsConfig,
} from "../src/config.js";
import { runAntigravitySerialized } from "../src/providers/antigravitySerializedRunner.js";

describe("Antigravity model families and effort", () => {
  it("keeps the durable default at model-family level", () => {
    expect(loadBotsConfig({}).antigravity.modelPreference).toEqual([
      ...DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE,
    ]);
    expect(DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE[0]).toBe("gemini-3.8-flash");
  });

  it("normalizes legacy effort-suffixed fallback triads without duplicate family retries", () => {
    const bots = loadBotsConfig({
      ANTIGRAVITY_MODEL_PREFERENCE: [
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-3.7-flash-high",
        "claude-sonnet-4-6",
      ].join(","),
    });
    expect(bots.antigravity.modelPreference).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "claude-sonnet-4-6",
    ]);
  });

  it("maps bridge effort to concrete Gemini Agy variants", () => {
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "low")).toBe("gemini-3.8-flash-low");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash-medium", "high")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "xhigh")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash", "max")).toBe("gemini-3.8-flash-high");
    expect(resolveAgyModelForEffort("gemini-3.8-flash-high", null)).toBe("gemini-3.8-flash-high");
  });

  it("keeps non-Gemini Agy fallbacks unchanged and preserves the 3.1 Pro compatibility mapping", () => {
    expect(resolveAgyModelForEffort("claude-sonnet-4-6", "high")).toBe("claude-sonnet-4-6");
    expect(resolveAgyModelForEffort("gemini-3.1-pro", "low")).toBe("gemini-3.1-pro-low");
    expect(resolveAgyModelForEffort("gemini-3.1-pro", "medium")).toBe("gemini-3.1-pro-high");
  });

  it("carries Agy effort out-of-band without adding an unsupported CLI flag", () => {
    const args = ["--output-format", "stream-json", "--print", "hi"];
    expect(appendEffortArgs("agy", args, "high")).toBe(args);
    expect(args).toEqual(["--output-format", "stream-json", "--print", "hi"]);
    expect(getAgyEffortForArgs(args)).toBe("high");
  });

  it("applies the effort-derived model while holding the serialized Agy state lock", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "agent-bridge-agy-effort-"));
    const sessionId = "c107dfbd-181e-4cf0-a840-894662adee43";
    const stream = [
      JSON.stringify({ event: "init", conversation_id: sessionId }),
      JSON.stringify({ event: "result", result: { conversation_id: sessionId, status: "SUCCESS", response: "ok" } }),
    ].join("\n");
    const args = ["-e", `process.stdout.write(${JSON.stringify(stream)})`];
    appendEffortArgs("agy", args, "high");
    const metadata = { homeDir, model: "gemini-3.8-flash", applyModel: true };

    try {
      await runAntigravitySerialized(
        process.execPath,
        args,
        homeDir,
        { bot: "antigravity", timeoutMs: 5_000, idleTimeoutMs: 5_000 },
        metadata,
      );
      const settings = JSON.parse(
        readFileSync(join(homeDir, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
      ) as { model?: string };
      expect(settings.model).toBe("Gemini 3.8 Flash (High)");
      expect(metadata.model).toBe("gemini-3.8-flash-high");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
