import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("offline baseline validator", () => {
  it("rejects unmanifested archive members and never needs production paths", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-offline-test-"));
    const archive = join(root, "artifact.tar.gz");
    const fixture = join(root, "fixtures");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "copy.sqlite"), "not-a-database");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      commit: "a".repeat(40), tree: "b".repeat(40), files: [],
    }));
    writeFileSync(join(root, "unexpected.txt"), "unexpected");
    execFileSync("tar", ["-czf", archive, "-C", root, "manifest.json", "unexpected.txt"]);
    expect(() => execFileSync("python3", [
      "scripts/offline-baseline-validate.py", "--archive", archive,
      "--target-commit", "a".repeat(40), "--expected-tree", "b".repeat(40),
      "--builder-commit", "c".repeat(40), "--rollout-helper-sha256", "d".repeat(64),
      "--db-root", fixture, "--output", join(root, "evidence.json"),
    ], { encoding: "utf8" })).toThrow(/manifest\/archive mismatch/);
  });
});
