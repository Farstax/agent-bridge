import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBundledRolloutDb } from "./support/rolloutDbBundled.js";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rollout-db-bundle-cache-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(root, "node_modules", "esbuild"), { recursive: true });
  writeFileSync(join(root, "node_modules", "esbuild", "package.json"), JSON.stringify({ version: "0-test" }));
  writeFileSync(join(root, "scripts", "rollout-db.ts"), 'await import("./rollout-db-impl.js");\n');
  writeFileSync(join(root, "scripts", "rollout-db-impl.ts"), 'export const marker = "v1";\n');

  const fakeEsbuild = join(root, "node_modules", ".bin", "esbuild");
  writeFileSync(fakeEsbuild, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const entrypoint = args.find((arg) => !arg.startsWith("--"));
const outfileArg = args.find((arg) => arg.startsWith("--outfile="));
const metafileArg = args.find((arg) => arg.startsWith("--metafile="));
if (!entrypoint || !outfileArg || !metafileArg) process.exit(2);
const outfile = outfileArg.slice("--outfile=".length);
const metafile = metafileArg.slice("--metafile=".length);
const inputs = [entrypoint, "scripts/rollout-db-impl.ts"];
const contents = inputs.map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8"));
fs.writeFileSync(outfile, contents.join("\\n"));
fs.writeFileSync(metafile, JSON.stringify({ inputs: Object.fromEntries(inputs.map((file, index) => [file, { bytes: contents[index].length }])) }));
fs.appendFileSync(path.join(process.cwd(), "build-count.log"), "build\\n");
`);
  chmodSync(fakeEsbuild, 0o755);
  return root;
}

function buildCount(root: string): number {
  const path = join(root, "build-count.log");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("rollout-db bundled test cache", () => {
  it("reuses unchanged inputs and rebuilds when the entrypoint or a bundled dependency changes", () => {
    const root = fixtureRoot();

    const first = getBundledRolloutDb(root);
    expect(readFileSync(first, "utf8")).toContain('marker = "v1"');
    expect(buildCount(root)).toBe(1);

    const unchanged = getBundledRolloutDb(root);
    expect(unchanged).toBe(first);
    expect(buildCount(root)).toBe(1);

    writeFileSync(join(root, "scripts", "rollout-db-impl.ts"), 'export const marker = "v2";\n');
    const dependencyChanged = getBundledRolloutDb(root);
    expect(dependencyChanged).not.toBe(first);
    expect(readFileSync(dependencyChanged, "utf8")).toContain('marker = "v2"');
    expect(buildCount(root)).toBe(2);

    writeFileSync(join(root, "scripts", "rollout-db.ts"), '// entrypoint changed\nawait import("./rollout-db-impl.js");\n');
    const entrypointChanged = getBundledRolloutDb(root);
    expect(entrypointChanged).not.toBe(dependencyChanged);
    expect(buildCount(root)).toBe(3);
  });
});
