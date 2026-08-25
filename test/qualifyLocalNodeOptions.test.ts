import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("qualify:local resource contract", () => {
  it("defaults to the hosted CI Node heap envelope without overriding an explicit caller value", () => {
    const script = readFileSync(join(process.cwd(), "scripts/qualify-local.sh"), "utf8");
    expect(script).toContain('export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"');
  });
});
