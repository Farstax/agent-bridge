import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandExistsOnPath } from "../src/interactiveCliAuth.js";
import { hasAgyRuntimePrerequisites } from "../src/providers/agyAvailability.js";

// Issue #1385: availability runs on every Workstream status projection, so it
// must not spawn subprocesses or re-hash an unchanged harness, while staying
// exactly as fresh as before.
describe("Issue #1385: provider availability hot path", () => {
  it("resolves PATH commands in-process like which", () => {
    const root = mkdtempSync(join(tmpdir(), "abp-path-"));
    try {
      writeFileSync(join(root, "plain"), "x"); chmodSync(join(root, "plain"), 0o644);
      const bin = join(root, "tool"); writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
      const path = ["", join(root, "missing"), root].join(delimiter);
      expect(commandExistsOnPath("tool", path)).toBe(true);
      expect(commandExistsOnPath("plain", path)).toBe(false);
      expect(commandExistsOnPath("absent", path)).toBe(false);
      expect(commandExistsOnPath(root, path)).toBe(false);
      expect(commandExistsOnPath(bin, "")).toBe(true);
      expect(commandExistsOnPath("", path)).toBe(false);
      chmodSync(bin, 0o644);
      expect(commandExistsOnPath("tool", path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-hashes the Agy harness whenever its file changes", () => {
    const root = mkdtempSync(join(tmpdir(), "abp-agy-"));
    try {
      const target = join(root, "localharness_external");
      const link = join(root, "link");
      writeFileSync(target, "#!/bin/sh\necho one\n"); chmodSync(target, 0o755);
      symlinkSync(target, link);
      writeFileSync(join(root, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        harnessName: "localharness_external",
        harnessSha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
      }));
      const check = () => hasAgyRuntimePrerequisites({ env: { ANTIGRAVITY_HARNESS_PATH: link } });
      expect(check()).toBe(true);
      expect(check()).toBe(true);
      // Same size, different content: the digest must be recomputed.
      writeFileSync(target, "#!/bin/sh\necho two\n");
      expect(check()).toBe(false);
      writeFileSync(target, "#!/bin/sh\necho one\n");
      expect(check()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
