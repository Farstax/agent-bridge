import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

function compiledArtifact(root: string) {
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "console.log('release');\n");
  writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", scripts: { build: "tsc" } }));
  return root;
}

describe("normalize Grok bin symlink", () => {
  it("rewrites a dereference-copied Grok bin so the release artifact stays contained", () => {
    const workspace = mkdtempSync(join(tmpdir(), "agent-bridge-grok-bin-normalize-"));
    const sourceNative = join(workspace, "source-grok-native");
    writeFileSync(sourceNative, "native-binary\n");
    const artifactRoot = join(workspace, "artifact");
    mkdirSync(artifactRoot);
    const root = compiledArtifact(artifactRoot);
    const binDir = join(root, "node_modules", "@xai-official", "grok", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "grok-native"), "native-binary\n");
    // Node's fs.cpSync({ dereference: true }) copies grok-native as a regular
    // file and rewrites bin/grok into an absolute symlink back at the source
    // tree, which escapes the artifact root.
    symlinkSync(sourceNative, join(binDir, "grok"));

    expect(() => buildReleaseManifest({
      root,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    })).toThrow(/release artifact symlink escaped root/);

    execFileSync(process.execPath, ["scripts/normalize-grok-bin-symlink.mjs", root]);

    expect(lstatSync(join(binDir, "grok")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(binDir, "grok"))).toBe("./grok-native");
    const manifest = buildReleaseManifest({
      root,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    });
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "node_modules/@xai-official/grok/bin/grok",
        type: "symlink",
        target: "./grok-native",
      }),
    ]));
  });

  it("repairs Node dereference copies of a Grok-like relative bin symlink", () => {
    const workspace = mkdtempSync(join(tmpdir(), "agent-bridge-grok-bin-cp-"));
    const sourceBin = join(workspace, "source", "node_modules", "@xai-official", "grok", "bin");
    mkdirSync(sourceBin, { recursive: true });
    writeFileSync(join(sourceBin, "grok-native"), "native-binary\n");
    symlinkSync("./grok-native", join(sourceBin, "grok"));
    const artifactRoot = join(workspace, "artifact");
    mkdirSync(artifactRoot);
    cpSync(join(workspace, "source", "node_modules"), join(artifactRoot, "node_modules"), {
      recursive: true,
      dereference: true,
    });
    const copied = join(artifactRoot, "node_modules", "@xai-official", "grok", "bin", "grok");
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copied)).toMatch(/^\//);

    execFileSync(process.execPath, ["scripts/normalize-grok-bin-symlink.mjs", artifactRoot]);

    expect(readlinkSync(copied)).toBe("./grok-native");
  });
});
