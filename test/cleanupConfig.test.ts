import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as T;

describe("cleanup audit configuration", () => {
  it("keeps the cleanup audit wired to Knip", () => {
    const pkg = readJson<{ scripts?: Record<string, string> }>("package.json");
    expect(pkg.scripts?.["cleanup:check"]).toBe("knip");
  });

  it("does not hide dead code by treating all scripts or tests as Knip entry points", () => {
    const knip = readJson<{ entry?: string[] }>("knip.json");
    const entries = knip.entry ?? [];

    expect(entries).not.toContain("scripts/**/*.ts");
    expect(entries).not.toContain("test/**/*.test.ts");
    expect(entries.some((entry) => entry.startsWith("scripts/") && entry.includes("*"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("test/") && entry.includes("*"))).toBe(false);
  });
});
