import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";

describe("parseCliResult edge cases", () => {
  // Every provider is ACP-backed now; there is no remaining native CLI
  // provider with real result text to parse here. See each provider's own
  // dedicated ACP runtime test (e.g. grokAcpRuntime.test.ts, cli.test.ts's
  // "antigravity ACP result contract") for its own fail-closed assertion.
  it("fails closed when parseCliResult is called on ACP-backed grok", () => {
    expect(() => parseCliResult({ bot: "grok", stdout: "{}" })).toThrow(/ACP structured results/);
  });

  it("fails closed when parseCliResult is called on ACP-backed claude", () => {
    expect(() => parseCliResult({ bot: "claude", stdout: "{}" })).toThrow(/ACP structured results/);
  });

  it("fails closed when parseCliResult is called on ACP-backed cursor", () => {
    expect(() => parseCliResult({ bot: "cursor", stdout: "{}" })).toThrow(/ACP structured results/);
  });

  it("throws for an unrecognized bot", () => {
    expect(() => parseCliResult({ bot: "not-a-real-bot", stdout: "{}" })).toThrow(/Unknown bot type/);
  });
});
