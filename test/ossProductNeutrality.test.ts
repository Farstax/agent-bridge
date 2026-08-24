import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const operationalRoots = ["skills", "src", "scripts", "systemd"];
const operationalRootFiles = readdirSync(".")
  .filter((name) => /^\.env\..*\.example$/.test(name));

function listTextFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(path, entry.name);
    if (entry.isDirectory()) return listTextFiles(full);
    return entry.isFile() ? [full] : [];
  });
}

describe("OSS product neutrality", () => {
  it("keeps operational OSS surfaces independent of the hosted product/control plane", () => {
    const files = [
      ...operationalRoots.flatMap(listTextFiles),
      ...operationalRootFiles,
    ];
    const violations = files.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const found: string[] = [];
      if (/farstax/i.test(text)) found.push("Farstax");
      if (/agent-bridge-platform/i.test(text)) found.push("agent-bridge-platform");
      return found.map((marker) => `${path}: ${marker}`);
    });

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
