import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type LockedPackage = { version: string };

function postcssVersions(packages: Record<string, LockedPackage>): string[] {
  return Object.entries(packages)
    .filter(([path]) => path === "node_modules/postcss" || path.endsWith("/node_modules/postcss"))
    .map(([, packageInfo]) => packageInfo.version);
}

function isPatchedPostcssVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;

  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 8 || (major === 8 && (minor > 5 || (minor === 5 && patch >= 23)));
}

describe("locked development dependencies", () => {
  it("finds nested PostCSS copies and accepts all safe later versions", () => {
    const versions = postcssVersions({
      "node_modules/postcss": { version: "8.5.23" },
      "node_modules/vite/node_modules/postcss": { version: "8.6.0" },
      "node_modules/other/node_modules/postcss": { version: "9.0.0" },
    });

    expect(versions).toEqual(["8.5.23", "8.6.0", "9.0.0"]);
    expect(isPatchedPostcssVersion("8.5.22")).toBe(false);
    expect(versions.every(isPatchedPostcssVersion)).toBe(true);
  });

  it("uses a PostCSS release that fixes the open source-map traversal advisories", () => {
    const lockfile = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf-8"));
    const versions = postcssVersions(lockfile.packages);

    expect(versions).not.toHaveLength(0);
    expect(versions.every(isPatchedPostcssVersion)).toBe(true);
  });
});
