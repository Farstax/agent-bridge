import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/providers/doctor.js";

const allFound = () => true;
const noneFound = () => false;
const voiceReady = () => ({ status: "ready" as const, reasonCode: null });

describe("doctor diagnostics", () => {
  it("reports provider commands as available when the executable resolves", () => {
    const report = runDoctor({ env: {}, commandExists: allFound, inspectVoiceRuntime: voiceReady });
    for (const p of report.providers) {
      expect(p.status).toBe("available");
    }
  });

  it("reports the configured provider executable when it resolves", () => {
    const configuredAgy = "/opt/antigravity/bin/agy";
    const report = runDoctor({
      env: {
        INTERACTIVE_CLI_CHAIN: "antigravity",
        ANTIGRAVITY_COMMAND: configuredAgy,
      },
      commandExists: (executable) => executable === configuredAgy,
      inspectVoiceRuntime: voiceReady,
    });

    expect(report.providers.find((p) => p.id === "agy")).toEqual({
      id: "agy",
      executable: configuredAgy,
      status: "available",
    });
    expect(report.ok).toBe(true);
  });

  it("reports provider commands as missing when the executable does not resolve", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,claude,antigravity,unsupported" },
      commandExists: noneFound,
      inspectVoiceRuntime: voiceReady,
    });
    expect(report.providers.length).toBeGreaterThan(0);
    for (const p of report.providers) {
      expect(p.status).toBe("missing");
    }
    expect(report.ok).toBe(false);
  });

  it("fails when providers referenced by unset runtime defaults are missing", () => {
    const report = runDoctor({ env: {}, commandExists: noneFound, inspectVoiceRuntime: voiceReady });

    expect(report.chains.find((chain) => chain.name === "INTERACTIVE_CLI_CHAIN")?.entries)
      .toEqual(["codex", "claude", "antigravity"]);
    expect(report.ok).toBe(false);
  });

  it("does not fail for an unavailable provider that no configured chain uses", () => {
    const configuredAgy = "/opt/antigravity/bin/agy-missing";
    const codexAcp = "/opt/agent-bridge/node_modules/.bin/codex-acp";
    const report = runDoctor({
      env: {
        INTERACTIVE_CLI_CHAIN: "codex",
        CODEX_ACP_COMMAND: codexAcp,
        ANTIGRAVITY_COMMAND: configuredAgy,
      },
      commandExists: (executable) => executable === codexAcp,
      inspectVersion: (executable) => executable === codexAcp ? "1.10.0" : null,
      inspectVoiceRuntime: voiceReady,
    });

    expect(report.providers.find((p) => p.id === "agy")).toEqual({
      id: "agy",
      executable: configuredAgy,
      status: "missing",
    });
    expect(report.ok).toBe(true);
  });

  it("fails when a configured provider executable is missing", () => {
    const configuredAgy = "/opt/antigravity/bin/agy-missing";
    const report = runDoctor({
      env: {
        INTERACTIVE_CLI_CHAIN: "antigravity",
        ANTIGRAVITY_COMMAND: configuredAgy,
      },
      commandExists: (executable) => executable !== configuredAgy,
      inspectVoiceRuntime: voiceReady,
    });

    expect(report.providers.find((p) => p.id === "agy")).toEqual({
      id: "agy",
      executable: configuredAgy,
      status: "missing",
    });
    expect(report.ok).toBe(false);
  });

  it("accepts a parseable fallback chain", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,claude,antigravity" },
      commandExists: allFound,
      inspectVoiceRuntime: voiceReady,
    });
    const chain = report.chains.find((c) => c.name === "INTERACTIVE_CLI_CHAIN");
    expect(chain?.ok).toBe(true);
    expect(chain?.entries).toEqual(["codex", "claude", "antigravity"]);
  });

  it("flags unknown entries in a fallback chain", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,not-a-cli" },
      commandExists: allFound,
      inspectVoiceRuntime: voiceReady,
    });
    const chain = report.chains.find((c) => c.name === "INTERACTIVE_CLI_CHAIN");
    expect(chain?.ok).toBe(false);
    expect(chain?.unknown).toContain("not-a-cli");
    expect(report.ok).toBe(false);
  });

  it("skips unset chains without failing", () => {
    const report = runDoctor({ env: {}, commandExists: allFound, inspectVoiceRuntime: voiceReady });
    for (const chain of report.chains) {
      expect(chain.ok).toBe(true);
    }
  });

  it("reports required env entries when requested", () => {
    const report = runDoctor({
      env: { TELEGRAM_BOT_TOKEN: "x" },
      requiredEnv: ["TELEGRAM_BOT_TOKEN", "MISSING_VAR"],
      commandExists: allFound,
      inspectVoiceRuntime: voiceReady,
    });
    expect(report.env.find((e) => e.name === "TELEGRAM_BOT_TOKEN")?.present).toBe(true);
    expect(report.env.find((e) => e.name === "MISSING_VAR")?.present).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("is ok when providers exist, chains parse, and env is present", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex,claude" },
      commandExists: allFound,
      inspectVoiceRuntime: voiceReady,
    });
    expect(report.ok).toBe(true);
  });

  it("projects voice STT readiness through the same effective runtime environment", () => {
    const inspectVoiceRuntime = vi.fn(() => ({
      status: "ready" as const,
      reasonCode: null,
    }));
    const env = {
      INTERACTIVE_CLI_CHAIN: "codex",
      AGENT_BRIDGE_STT_ROOT: "/opt/agent-bridge/host-components/voice-stt",
    };
    const report = runDoctor({ env, commandExists: allFound, inspectVoiceRuntime });

    expect(inspectVoiceRuntime).toHaveBeenCalledWith(env);
    expect(report.voiceTranscription).toEqual({ status: "ready", reasonCode: null });
    expect(report.ok).toBe(true);
  });

  it("fails Doctor when voice STT is enabled but runtime readiness fails", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex" },
      commandExists: allFound,
      inspectVoiceRuntime: () => ({ status: "unavailable", reasonCode: "voice_runtime_preflight_failed" }),
    });
    expect(report.voiceTranscription.reasonCode).toBe("voice_runtime_preflight_failed");
    expect(report.ok).toBe(false);
  });

  it("does not fail Doctor when voice transcription is explicitly disabled", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex", AGENT_BRIDGE_VOICE_TRANSCRIPTION: "disabled" },
      commandExists: allFound,
      inspectVoiceRuntime: () => ({ status: "unavailable", reasonCode: "voice_transcription_disabled" }),
    });
    expect(report.ok).toBe(true);
  });

  it("checks the managed ACP adapter for Codex", () => {
    const adapter = "/opt/agent-bridge/releases/current/node_modules/.bin/codex-acp";
    const report = runDoctor({
      env: {
        INTERACTIVE_CLI_CHAIN: "codex",
        BRIDGE_CURRENT_RELEASE_DIR: "/opt/agent-bridge/releases/current",
      },
      commandExists: (executable) => executable === adapter,
      inspectVersion: (executable) => executable === adapter ? "1.10.0" : null,
      inspectVoiceRuntime: voiceReady,
    });
    const codex = report.providers.find((p) => p.id === "codex");
    expect(codex).toEqual(expect.objectContaining({
      id: "codex",
      executable: adapter,
      status: "available",
      runtime: "acp",
      version: "1.10.0",
    }));
    expect(report.ok).toBe(true);
  });

  it("fails when only the legacy Codex executable exists", () => {
    const report = runDoctor({
      env: {
        INTERACTIVE_CLI_CHAIN: "codex",
        CODEX_COMMAND: "codex",
      },
      commandExists: (executable) => executable === "codex",
      inspectVoiceRuntime: voiceReady,
    });
    const codex = report.providers.find((p) => p.id === "codex");
    expect(codex?.runtime).toBe("acp");
    expect(codex?.executable).not.toBe("codex");
    expect(codex?.status).toBe("missing");
    expect(report.ok).toBe(false);
  });

  it("respects a custom CODEX_ACP_COMMAND", () => {
    const custom = "/usr/local/bin/custom-codex-acp";
    const report = runDoctor({
      env: {
        INTERACTIVE_CLI_CHAIN: "codex",
        CODEX_ACP_COMMAND: custom,
      },
      commandExists: (executable) => executable === custom,
      inspectVersion: (executable) => executable === custom ? "1.10.0" : null,
      inspectVoiceRuntime: voiceReady,
    });
    expect(report.providers.find((p) => p.id === "codex")).toEqual(expect.objectContaining({
      executable: custom,
      status: "available",
      runtime: "acp",
    }));
    expect(report.ok).toBe(true);
  });

  it("fails closed when an available ACP runtime does not return a version", () => {
    const report = runDoctor({
      env: { INTERACTIVE_CLI_CHAIN: "codex" },
      commandExists: allFound,
      inspectVersion: () => null,
      inspectVoiceRuntime: voiceReady,
    });
    expect(report.providers.find((p) => p.id === "codex")).toMatchObject({
      status: "invalid",
      reason: "unable to inspect ACP runtime version",
    });
    expect(report.ok).toBe(false);
  });

});
