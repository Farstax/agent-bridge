import { describe, expect, it } from "vitest";
import { resolveExecutionCapacityConfig } from "../src/config.js";

describe("execution capacity configuration", () => {
  it("keeps OSS unrestricted by default and requires a shared managed coordinator for a positive cap", () => {
    expect(resolveExecutionCapacityConfig({})).toEqual({ maxConcurrentExecutions: 0, coordinatorDbPath: null });
    expect(() => resolveExecutionCapacityConfig({ AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS: "2" }))
      .toThrow(/AGENT_BRIDGE_EXECUTION_COORDINATION_DB_PATH/);
    expect(resolveExecutionCapacityConfig({
      AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS: "2",
      AGENT_BRIDGE_EXECUTION_COORDINATION_DB_PATH: "/var/lib/agent-bridge/interactive/bridge.sqlite",
    })).toEqual({ maxConcurrentExecutions: 2, coordinatorDbPath: "/var/lib/agent-bridge/interactive/bridge.sqlite" });
  });

  it.each(["-1", "1.5", "two", " 2", "2 "])("rejects malformed cap %j", (value) => {
    expect(() => resolveExecutionCapacityConfig({ AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS: value }))
      .toThrow(/AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS/);
  });
});
