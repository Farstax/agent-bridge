import { describe, expect, it } from "vitest";
import { resolveAutonomyRuntimeConfig } from "../src/config.js";

describe("interactive Telegram autonomy configuration", () => {
  it("enables autonomy only when both managed paths are provided", () => {
    expect(resolveAutonomyRuntimeConfig({
      AGENT_BRIDGE_AUTONOMY_DIR: "/var/lib/agent-bridge/autonomy",
      AGENT_BRIDGE_AUTONOMY_DB_PATH: "/var/lib/agent-bridge/autonomy/autonomy.sqlite",
      AGENT_BRIDGE_AUTONOMY_MAX_CYCLES: "20",
    })).toEqual({
      enabled: true,
      dir: "/var/lib/agent-bridge/autonomy",
      dbPath: "/var/lib/agent-bridge/autonomy/autonomy.sqlite",
      maxCycles: 20,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 5,
    });
  });

  it("defaults to disabled autonomy with bounded policy", () => {
    expect(resolveAutonomyRuntimeConfig({})).toMatchObject({
      enabled: false, maxCycles: 3, requireEpisodeApproval: true, maxEpisodesPerDay: 5,
    });
  });

  it("rejects unmatched or relative paths and invalid cycle budgets", () => {
    expect(() => resolveAutonomyRuntimeConfig({
      AGENT_BRIDGE_AUTONOMY_DIR: "/var/lib/agent-bridge/autonomy",
    })).toThrow(/configured together/);
    expect(() => resolveAutonomyRuntimeConfig({
      AGENT_BRIDGE_AUTONOMY_DIR: "relative", AGENT_BRIDGE_AUTONOMY_DB_PATH: "/tmp/db",
    })).toThrow(/must be absolute/);
    expect(() => resolveAutonomyRuntimeConfig({
      AGENT_BRIDGE_AUTONOMY_MAX_CYCLES: "not-a-number",
    })).toThrow(/positive integer/);
  });
});
