import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertReleaseTagAfter,
  compareReleaseTags,
  maxReleaseTag,
  releaseCompatibilityVersion,
} from "../scripts/releaseVersion.mjs";

describe("release compatibility ordering", () => {
  it("orders date and sequence release tags in compatibility order", () => {
    expect(compareReleaseTags("release-2026.09.07-2", "release-2026.09.07-1")).toBeGreaterThan(0);
    expect(compareReleaseTags("release-2026.09.08-1", "release-2026.09.07-99")).toBeGreaterThan(0);
    expect(compareReleaseTags("release-2026.09.07-1", "release-2026.09.08-1")).toBeLessThan(0);
    expect(releaseCompatibilityVersion("release-2026.09.07-2")).toBe("2026.9.7-2");
  });

  it("selects the maximum release identity independently of API ordering", () => {
    expect(maxReleaseTag([
      "release-2026.09.07-2",
      "release-2026.09.06-9",
      "release-2026.09.08-1",
      "release-2026.09.07-99",
    ])).toBe("release-2026.09.08-1");
    expect(maxReleaseTag([])).toBeUndefined();
    expect(() => maxReleaseTag(["not-a-release"])).toThrow(/release tag/);
  });

  it("fails closed when a publication tag does not advance the latest release identity", () => {
    expect(assertReleaseTagAfter("release-2026.09.07-1", "release-2026.09.07-2")).toBe("2026.9.7-2");
    expect(() => assertReleaseTagAfter("release-2026.09.07-2", "release-2026.09.07-2"))
      .toThrow(/must be newer than latest published release/);
    expect(() => assertReleaseTagAfter("release-2026.09.07-2", "release-2026.09.06-9"))
      .toThrow(/must be newer than latest published release/);
  });

  it("serializes release publication and applies the shared monotonic gate", () => {
    const workflow = readFileSync(
      fileURLToPath(new URL("../.github/workflows/publish-release.yml", import.meta.url)),
      "utf8",
    );
    expect(workflow).toMatch(/concurrency:\s*\n\s*group:\s*publish-release\s*\n\s*cancel-in-progress:\s*false/);
    expect(workflow).toContain("gh api --paginate --slurp");
    expect(workflow).toContain('import { maxReleaseTag } from "./scripts/releaseVersion.mjs";');
    expect(workflow).toContain('node scripts/releaseVersion.mjs --assert-after "$previous_tag" "$RELEASE_TAG"');
    expect(workflow).toContain('PREVIOUS_TAG: ${{ steps.release_order.outputs.previous_tag }}');
  });
});
