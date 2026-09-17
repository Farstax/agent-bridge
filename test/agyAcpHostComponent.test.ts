import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

describe("Agy ACP managed host component", () => {
  it("declares a release host component owned by the transactional activation lifecycle", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      agentBridge?: { hostComponents?: Array<{ id?: string; installer?: string }> };
    };
    expect(pkg.agentBridge?.hostComponents).toContainEqual({
      id: "agy-acp",
      installer: "scripts/install-agy-acp.sh",
    });
  });

  it("installs from the release-locked ACP registry entry rather than a duplicated version constant", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    expect(installer).toContain("dist/providers/acpRegistry.js");
    expect(installer).toContain("getLockedAcpRegistryEntry");
    expect(installer).toContain("host_component_status=");
    expect(installer).not.toMatch(/antigravity-acp@\d/);
  });
});
