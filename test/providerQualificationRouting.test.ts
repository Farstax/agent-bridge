import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getAvailableCliKinds } from "../src/interactiveCliAuth.js";
import { PROVIDER_CONTRACT_VERSION, writeQualificationRecord } from "../src/providers/qualification.js";
import { getQualificationFailedProviders } from "../src/providers/qualificationStatus.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";

describe("provider qualification routing", () => {
  it("reads hard failures from persisted qualification evidence for the installed version", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-routing-"));
    const evidencePath = join(root, "qualification.json");
    writeQualificationRecord({
      provider: "agy",
      providerVersion: "1.1.12",
      previousVersion: "1.1.11",
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-10T17:00:00.000Z",
      environment: "managed-appliance",
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "fail", diagnostic: "native JSON contract drift" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);
    writeQualificationRecord({
      provider: "claude",
      providerVersion: "2.3.4",
      previousVersion: "2.3.3",
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-10T17:00:01.000Z",
      environment: "managed-appliance",
      overall: "degraded",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "not_authenticated" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);

    expect([...getQualificationFailedProviders(evidencePath, {
      agy: "1.1.12",
      claude: "2.3.4",
    })]).toEqual(["agy"]);
  });

  it("does not block a newly installed version using stale failure evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "qualification-routing-version-change-"));
    const evidencePath = join(root, "qualification.json");
    writeQualificationRecord({
      provider: "agy",
      providerVersion: "1.1.12",
      previousVersion: "1.1.11",
      bridgeCommit: "e".repeat(40),
      contractVersion: PROVIDER_CONTRACT_VERSION,
      qualifiedAt: "2026-08-10T17:00:00.000Z",
      environment: "managed-appliance",
      overall: "fail",
      checks: [
        { name: "version", status: "pass" },
        { name: "fresh_prompt", status: "fail", diagnostic: "native JSON contract drift" },
        { name: "session_resume", status: "not_applicable" },
      ],
    }, evidencePath);

    expect([...getQualificationFailedProviders(evidencePath, { agy: "1.1.13" })]).toEqual([]);
  });

  it("excludes only providers with hard qualification failures from interactive selection", () => {
    const available = getAvailableCliKinds({
      homeDir: "/qualification-test-home",
      exists: () => true,
      commandExists: () => true,
      failedProviders: new Set(["codex", "agy"]),
    });

    expect([...available]).toEqual(["claude"]);
  });

  it("skips unavailable providers when advancing the fallback chain", () => {
    const db = openDb(":memory:");
    const chain = new ProviderFallbackChain(
      ["codex", "claude", "antigravity"],
      db,
      (cli) => cli !== "claude",
    );

    expect(chain.getChain()).toEqual(["codex", "antigravity"]);
    expect(chain.getActiveCli("chat:1")).toBe("codex");
    expect(chain.advance("chat:1")).toBe("antigravity");
    expect(chain.isChainExhausted("chat:1")).toBe(true);
  });

  it("moves the effective active provider past an unavailable chain head without retrying it", () => {
    const db = openDb(":memory:");
    const chain = new ProviderFallbackChain(
      ["codex", "claude", "antigravity"],
      db,
      (cli) => cli !== "codex",
    );

    expect(chain.getActiveCli("chat:1")).toBe("claude");
    expect(chain.getChain()).toEqual(["claude", "antigravity"]);
    expect(chain.advance("chat:1")).toBe("antigravity");
  });
});
