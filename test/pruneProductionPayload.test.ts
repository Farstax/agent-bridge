import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/prune-production-payload.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function releaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-prune-"));
  roots.push(root);
  return root;
}

function prune(root: string): { removed_count: number; removed_bytes: number } {
  const stdout = execFileSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  return JSON.parse(stdout) as { removed_count: number; removed_bytes: number };
}

describe("production payload prune", () => {
  it("removes declarations, source maps and a redundant grok brotli payload, and keeps runtime files", () => {
    const root = releaseRoot();
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules/@xai-official/grok/bin"), { recursive: true });
    mkdirSync(join(root, "node_modules/@xai-official/grok-linux-x64/bin"), { recursive: true });
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "dist/index.js"), "runtime\n");
    writeFileSync(join(root, "dist/index.js.map"), "{\"version\":3}\n");
    writeFileSync(join(root, "dist/index.d.ts"), "export {}\n");
    writeFileSync(join(root, "src/index.ts"), "export {}\n");
    writeFileSync(join(root, "node_modules/pkg/index.js"), "pkg\n");
    writeFileSync(join(root, "node_modules/pkg/index.d.ts"), "export {}\n");
    writeFileSync(join(root, "node_modules/pkg/index.d.mts"), "export {}\n");
    writeFileSync(join(root, "node_modules/pkg/index.d.cts"), "export {}\n");
    writeFileSync(join(root, "node_modules/pkg/README.md"), "# keep\n");
    writeFileSync(join(root, "node_modules/@xai-official/grok/bin/grok-native"), "elf");
    symlinkSync("grok-native", join(root, "node_modules/@xai-official/grok/bin/grok"));
    writeFileSync(join(root, "node_modules/@xai-official/grok-linux-x64/bin/grok.br"), "brotli");

    const outside = releaseRoot();
    writeFileSync(join(outside, "outside.d.ts"), "stay\n");
    symlinkSync(join(outside, "outside.d.ts"), join(root, "quoted.d.ts"));
    symlinkSync(outside, join(root, "linked-tree"));

    const result = prune(root);

    expect(result.removed_count).toBe(6);
    expect(result.removed_bytes).toBeGreaterThan(0);
    expect(lstatSync(join(root, "dist/index.js")).isFile()).toBe(true);
    expect(lstatSync(join(root, "src/index.ts")).isFile()).toBe(true);
    expect(lstatSync(join(root, "node_modules/pkg/index.js")).isFile()).toBe(true);
    expect(lstatSync(join(root, "node_modules/pkg/README.md")).isFile()).toBe(true);
    expect(lstatSync(join(root, "node_modules/@xai-official/grok/bin/grok-native")).isFile()).toBe(true);
    expect(readlinkSync(join(root, "node_modules/@xai-official/grok/bin/grok"))).toBe("grok-native");
    expect(lstatSync(join(root, "quoted.d.ts")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(outside, "outside.d.ts")).isFile()).toBe(true);
    for (const removed of [
      "dist/index.js.map",
      "dist/index.d.ts",
      "node_modules/pkg/index.d.ts",
      "node_modules/pkg/index.d.mts",
      "node_modules/pkg/index.d.cts",
      "node_modules/@xai-official/grok-linux-x64/bin/grok.br",
    ]) {
      expect(() => lstatSync(join(root, removed))).toThrow();
    }
  });

  it("keeps the grok brotli payload when the native binary is not the active link", () => {
    const root = releaseRoot();
    mkdirSync(join(root, "node_modules/@xai-official/grok/bin"), { recursive: true });
    mkdirSync(join(root, "node_modules/@xai-official/grok-linux-x64/bin"), { recursive: true });
    writeFileSync(join(root, "node_modules/@xai-official/grok/bin/grok"), "wrapper\n");
    writeFileSync(join(root, "node_modules/@xai-official/grok-linux-x64/bin/grok.br"), "brotli");

    const result = prune(root);

    expect(result.removed_count).toBe(0);
    expect(lstatSync(join(root, "node_modules/@xai-official/grok-linux-x64/bin/grok.br")).isFile()).toBe(true);
  });
});
