import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("local/hosted CI parity", () => {
  it("exposes one documented npm command for the authoritative pre-merge gate", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["qualify:local"]).toBe("bash scripts/qualify-local.sh");
  });

  it("runs the full deterministic pack: tests, typecheck, architecture lint", () => {
    const script = readFileSync(join(root, "scripts/qualify-local.sh"), "utf8");
    expect(script).toContain("npm test");
    expect(script).toContain("npm run typecheck");
    expect(script).toContain("scripts/arch-lint.sh");
  });

  it("has GitHub Actions call the same local script rather than duplicating steps", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("npm run qualify:local");
    expect(workflow).not.toMatch(/run:\s*npm test\s*$/m);
    expect(workflow).not.toMatch(/run:\s*npm run typecheck\s*$/m);
  });
});
