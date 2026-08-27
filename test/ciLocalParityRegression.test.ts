import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createCiFixture } from "./support/ciFixture.js";

const root = process.cwd();
const ciFixture = createCiFixture(root);

afterAll(() => ciFixture.cleanup());

describe("local/hosted CI parity", () => {
  it("exposes one documented npm command for the authoritative pre-merge gate", () => {
    const pkg = JSON.parse(readFileSync(ciFixture.path("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["qualify:local"]).toBe("bash scripts/qualify-local.sh");
  });

  it("owns the deterministic resource envelope and full pre-merge pack", () => {
    const script = readFileSync(ciFixture.path("scripts/qualify-local.sh"), "utf8");
    expect(script).toContain("--max-old-space-size=3072");
    expect(script).toContain("npm test");
    expect(script).toContain("npm run typecheck");
    expect(script).toContain("scripts/arch-lint.sh");
  });

  it("has GitHub Actions call the same local script rather than duplicating steps", () => {
    const workflow = readFileSync(ciFixture.path(".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("npm run qualify:local");
    expect(workflow).not.toMatch(/run:\s*npm test\s*$/m);
    expect(workflow).not.toMatch(/run:\s*npm run typecheck\s*$/m);
  });

  it("keeps hosted CI cancellation stable per PR or ref", () => {
    const workflow = readFileSync(ciFixture.path(".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("group: ci-${{ github.event.pull_request.number || github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).not.toContain("github.run_id");
  });
});
