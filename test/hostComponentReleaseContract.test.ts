import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

function compiledRoot(packageJson: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-host-component-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "export {};\n");
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", scripts: { build: "tsc" }, ...packageJson }));
  return root;
}

function manifest(root: string) {
  return buildReleaseManifest({
    root,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    nodeVersion: "v24.15.0",
    platform: "linux",
    arch: "x64",
  });
}

describe("release-owned host components", () => {
  it("binds a declared installer to the manifest file inventory", () => {
    const root = compiledRoot({
      agentBridge: { hostComponents: [{ id: "voice-stt", installer: "scripts/install-voice-stt.sh" }] },
    });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "install-voice-stt.sh"), "#!/bin/sh\nexit 0\n");

    const built = manifest(root);
    expect(built.host_components).toEqual([{ id: "voice-stt", installer: "scripts/install-voice-stt.sh" }]);
    expect(built.files.find((entry: { path: string }) => entry.path === "scripts/install-voice-stt.sh")?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when a current source declaration loses its installer", () => {
    const root = compiledRoot({
      agentBridge: { hostComponents: [{ id: "voice-stt", installer: "scripts/install-voice-stt.sh" }] },
    });
    expect(() => manifest(root)).toThrow(/installer is missing or not a regular packaged file/);
  });

  it("keeps genuine pre-declaration historical artifacts free of fabricated requirements", () => {
    const built = manifest(compiledRoot({}));
    expect(built.host_components).toBeUndefined();
  });
});
