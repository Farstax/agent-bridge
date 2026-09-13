import { describe, expect, it } from "vitest";
import { claudeAcpPolicy } from "../src/providers/claudeAcpPolicy.js";
import { codexAcpPolicy } from "../src/providers/codexAcpPolicy.js";

describe("ACP steering qualification gate (issue #748)", () => {
  it("qualifies Claude for steering (claude-agent-acp@0.76.0 carries the host-owned promptRequired fallback)", () => {
    expect(claudeAcpPolicy.steeringSupported).toBe(true);
  });

  it("does not qualify Codex, independent of what a live agent advertises (codex-acp#441 unreleased)", () => {
    expect(codexAcpPolicy.steeringSupported).not.toBe(true);
  });
});
