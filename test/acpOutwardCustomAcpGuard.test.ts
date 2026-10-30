/**
 * #1114 gap item 7: providers/selection.ts::interactiveChainKinds() permits
 * configured "custom-acp" (it has no fixed CLI binary; interactive chat
 * surfaces load its command/model per conversation via slash commands), but
 * outward ACP has no mechanism to load that per-session config — it builds
 * one BridgeEngine per provider for the whole process from a static
 * loadBotsConfig() lookup, which has no "custom-acp" entry. Before this fix,
 * a configured custom-acp chain head or BRIDGE_PROVIDER_LOCK=custom-acp
 * would silently construct a BridgeEngine with botConfig === undefined and
 * fail with an obscure runtime error deep inside execution, instead of
 * failing closed before admission.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createProductionOutwardAcpPromptExecutor, outwardCommandConfig } from "../src/acpServer/execution.js";

describe("outward ACP custom-acp guard (#1114)", () => {
  it("fails closed on BRIDGE_PROVIDER_LOCK=custom-acp instead of building an engine with an undefined bot config", () => {
    const db = openDb(":memory:");
    try {
      expect(() => createProductionOutwardAcpPromptExecutor(db, ":memory:", { BRIDGE_PROVIDER_LOCK: "custom-acp" }))
        .toThrow(/custom-acp/i);
    } finally {
      db.close();
    }
  });

  it.each(["custom-acp", "custom-acp,codex", "codex,custom-acp"])("rejects an explicit unsupported chain %s before admission", (chain) => {
    const db = openDb(":memory:");
    try {
      expect(() => createProductionOutwardAcpPromptExecutor(db, ":memory:", { INTERACTIVE_CLI_CHAIN: chain }))
        .toThrow(/custom-acp/i);
    } finally {
      db.close();
    }
  });

  it("outwardCommandConfig also fails closed when locked to custom-acp", () => {
    expect(() => outwardCommandConfig(":memory:", { BRIDGE_PROVIDER_LOCK: "custom-acp" })).toThrow(/custom-acp/i);
  });
});
