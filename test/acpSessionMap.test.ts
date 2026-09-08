import { describe, expect, it } from "vitest";
import {
  AcpSessionMap,
  type AcpSessionBinding,
} from "../src/acp/sessionMap.js";

function binding(overrides: Partial<AcpSessionBinding> = {}): AcpSessionBinding {
  return {
    conversationId: "conv-bridge-1",
    runId: "run-1",
    providerId: "codex",
    acpSessionId: "acp-sess-aaa",
    ...overrides,
  };
}

describe("ACP session identity mapping", () => {
  it("binds a fresh ACP session without using it as the Bridge conversation identity", () => {
    const map = new AcpSessionMap();
    map.bind(binding());

    const found = map.lookup("conv-bridge-1", "codex");
    expect(found?.acpSessionId).toBe("acp-sess-aaa");
    expect(found?.conversationId).toBe("conv-bridge-1");
    expect(found?.conversationId).not.toBe(found?.acpSessionId);
  });

  it("resumes the same ACP session for the same Bridge conversation and provider", () => {
    const map = new AcpSessionMap();
    map.bind(binding({ runId: "run-1" }));
    map.bind(binding({ runId: "run-2" }));

    const found = map.lookup("conv-bridge-1", "codex");
    expect(found?.acpSessionId).toBe("acp-sess-aaa");
    expect(found?.runId).toBe("run-2");
    expect(found?.conversationId).toBe("conv-bridge-1");
  });

  it("restores the mapping after a simulated Bridge restart", () => {
    const map = new AcpSessionMap();
    map.bind(binding());
    const snapshot = map.serialize();

    const restored = AcpSessionMap.deserialize(snapshot);
    expect(restored.lookup("conv-bridge-1", "codex")).toEqual(binding());
  });

  it("keeps the Bridge conversation identity stable across provider fallback/handoff", () => {
    const map = new AcpSessionMap();
    map.bind(binding({ acpSessionId: "acp-codex-1", providerId: "codex" }));
    map.bind(binding({
      acpSessionId: "acp-claude-9",
      providerId: "claude",
      runId: "run-handoff",
    }));

    expect(map.lookup("conv-bridge-1", "codex")?.conversationId).toBe("conv-bridge-1");
    expect(map.lookup("conv-bridge-1", "claude")?.conversationId).toBe("conv-bridge-1");
    expect(map.lookup("conv-bridge-1", "codex")?.acpSessionId).toBe("acp-codex-1");
    expect(map.lookup("conv-bridge-1", "claude")?.acpSessionId).toBe("acp-claude-9");
    expect(map.lookup("conv-bridge-1", "codex")?.acpSessionId)
      .not.toBe(map.lookup("conv-bridge-1", "claude")?.acpSessionId);
  });

  it("refuses to bind a provider ACP session id that equals the Bridge conversation id", () => {
    const map = new AcpSessionMap();
    expect(() => map.bind(binding({ acpSessionId: "conv-bridge-1" }))).toThrow(/must not equal/);
  });

  it("clears only the named provider binding", () => {
    const map = new AcpSessionMap();
    map.bind(binding({ providerId: "codex", acpSessionId: "acp-codex-1" }));
    map.bind(binding({ providerId: "claude", acpSessionId: "acp-claude-9" }));
    map.clear("conv-bridge-1", "codex");

    expect(map.lookup("conv-bridge-1", "codex")).toBeNull();
    expect(map.lookup("conv-bridge-1", "claude")?.acpSessionId).toBe("acp-claude-9");
  });
});
