import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("locked development dependencies", () => {
  it("uses a PostCSS release that fixes the open source-map traversal advisories", () => {
    const lockfile = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf-8"));
    const postcss = lockfile.packages["node_modules/postcss"];

    expect(postcss.version).toMatch(/^8\.5\.(?:2[3-9]|[3-9]\d)$/);
  });
});
