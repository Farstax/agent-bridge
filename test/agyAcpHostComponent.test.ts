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
    expect(installer).toContain("binary.sha256");
    expect(installer).toContain("host_component_status=");
    expect(installer).not.toMatch(/antigravity-acp@\d/);
  });

  it("keeps the installed binary path traversable by the unprivileged runtime user", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    expect(installer).toContain('VERSION_DIR="${ROOT}/components/${VERSION}"');
    expect(installer).toContain('normalize_runtime_dir "${VERSION_DIR}"');
    expect(installer).toContain('normalize_runtime_dir "${COMPONENT_DIR}"');
    expect(installer).toContain('chmod 0755 "${path}"');
    expect(installer).toContain('stat -c \'%u:%g:%a\' "${VERSION_DIR}"');
    expect(installer).toContain('stat -c \'%u:%g:%a\' "${COMPONENT_DIR}"');
  });

  it("packages the installer and verifies every declared host component generically", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release-artifact.yml"), "utf8");
    expect(workflow).toContain("scripts/install-agy-acp.sh");
    expect(workflow).toContain("for (const component of manifest.host_components ?? [])");
    expect(workflow).not.toContain('find((entry) => entry.id === "voice-stt")');
  });
});
