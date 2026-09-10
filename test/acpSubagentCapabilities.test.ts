import { describe, expect, it } from "vitest";
import { BRIDGE_ACP_CLIENT_CAPABILITIES, bridgeInitializeRequest } from "../src/acp/capabilities.js";

describe("ACP subagent capability negotiation", () => {
  it("advertises the native subagent extension without losing existing capabilities", () => {
    expect(BRIDGE_ACP_CLIENT_CAPABILITIES.plan).toEqual({});
    expect((BRIDGE_ACP_CLIENT_CAPABILITIES as Record<string, unknown>).subagents).toEqual({});
    expect((bridgeInitializeRequest().clientCapabilities as Record<string, unknown>).subagents).toEqual({});
  });
});
