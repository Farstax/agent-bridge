import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PRUNE = resolve(process.cwd(), "scripts/prune-release-tree.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content = "x", mode = 0o644): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  chmodSync(target, mode);
}

function fixture(withNativeGrok = true): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-prune-"));
  roots.push(root);
  write(root, "dist/index.js", "export {};\n");
  write(root, "dist/index.d.ts");
  write(root, "dist/index.js.map");
  write(root, "src/index.ts", "export {};\n");
  write(root, "node_modules/zod/index.js");
  write(root, "node_modules/zod/index.d.ts");
  write(root, "node_modules/zod/index.d.mts");
  write(root, "node_modules/zod/index.d.cts");
  write(root, "node_modules/zod/index.js.map");
  write(root, "node_modules/@xai-official/grok-linux-x64/bin/grok.br", "payload");
  if (withNativeGrok) {
    write(root, "node_modules/@xai-official/grok/bin/grok-native", "#!/bin/sh\n", 0o755);
    symlinkSync("./grok-native", join(root, "node_modules/@xai-official/grok/bin/grok"));
  }
  return root;
}

describe("release tree pruning (#1100)", () => {
  it("removes declarations, source maps and the redundant Grok payload only", () => {
    const root = fixture();
    const result = spawnSync("bash", [PRUNE, root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const removed of ["dist/index.d.ts", "dist/index.js.map", "node_modules/zod/index.d.ts", "node_modules/zod/index.d.mts",
      "node_modules/zod/index.d.cts", "node_modules/zod/index.js.map", "node_modules/@xai-official/grok-linux-x64/bin/grok.br"]) {
      expect(existsSync(join(root, removed)), removed).toBe(false);
    }
    for (const kept of ["dist/index.js", "src/index.ts", "node_modules/zod/index.js", "node_modules/@xai-official/grok/bin/grok-native"]) {
      expect(existsSync(join(root, kept)), kept).toBe(true);
    }
  });

  it("keeps the Grok payload when the native binary was not installed", () => {
    const root = fixture(false);
    const result = spawnSync("bash", [PRUNE, root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, "node_modules/@xai-official/grok-linux-x64/bin/grok.br"), "utf8")).toBe("payload");
    expect(result.stderr).toMatch(/keeping Grok payload/);
  });

  it("refuses a root without node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-prune-empty-"));
    roots.push(root);
    expect(spawnSync("bash", [PRUNE, root], { encoding: "utf8" }).status).not.toBe(0);
  });

  it("runs before the release manifest is generated", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");
    const prune = workflow.indexOf("scripts/prune-release-tree.sh");
    expect(prune).toBeGreaterThan(0);
    expect(prune).toBeLessThan(workflow.indexOf("node scripts/releaseManifest.mjs"));
    for (const pattern of ["'*.map'", "'*.d.ts'", "'*.d.mts'", "'*.d.cts'"]) expect(workflow).toContain(`-name ${pattern}`);
    expect(workflow).toContain('test ! -e "$root/node_modules/@xai-official/grok-linux-x64/bin/grok.br"');
  });
});
