import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import setup from "./globalTempRoot.js";

describe("suite temporary root", () => {
  it("routes worker fixtures into the run-owned root", () => {
    expect(basename(tmpdir())).toMatch(/^agent-bridge-/);
  });

  it("removes every fixture, including read-only trees, and restores TMPDIR", () => {
    const previous = process.env.TMPDIR;
    const teardown = setup();
    const root = process.env.TMPDIR!;
    try {
      expect(basename(root)).toMatch(/^agent-bridge-/);
      const leaked = mkdtempSync(join(tmpdir(), "leaked-fixture-"));
      mkdirSync(join(leaked, "nested"));
      writeFileSync(join(leaked, "nested", "data"), "x".repeat(4096));
      chmodSync(join(leaked, "nested"), 0o555);
      chmodSync(leaked, 0o555);
    } finally {
      teardown();
    }
    expect(existsSync(root)).toBe(false);
    expect(process.env.TMPDIR).toBe(previous);
  });
});
