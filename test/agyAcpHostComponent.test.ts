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
    expect(installer).toContain("localharness_external");
    expect(installer).toContain("harnessSha256");
    expect(installer).toContain("harnessPath");
    expect(installer).toContain("harnessVersion");
    expect(installer).toContain("harnessArchiveUrl");
    expect(installer).toContain("archiveSha256");
    expect(installer).toContain("AGENT_BRIDGE_AGY_HARNESS_LINK");
    expect(installer).not.toMatch(/antigravity-acp@\d/);
  });

  it("streams large managed executables instead of buffering them in activation memory", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    expect(installer).toContain("shutil.copyfileobj");
    expect(installer).toContain("stream.read(1024 * 1024)");
    expect(installer).toContain("bundle.open(member");
    expect(installer).not.toContain(".read_bytes()");
    expect(installer).not.toContain("bundle.read(");
  });

  it("checks disk headroom against the remote archive size before downloading or staging", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    const preflightIndex = installer.indexOf("remote_length=");
    const workDirIndex = installer.indexOf('work="$(mktemp -d');
    const curlDownloadIndex = installer.indexOf('--output "${archive}"');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(workDirIndex).toBeGreaterThan(-1);
    expect(curlDownloadIndex).toBeGreaterThan(-1);
    // The disk-space check must run before any staging directory is created
    // or bytes are downloaded, so a failed check never leaves temporary
    // material behind and never races a doomed download.
    expect(preflightIndex).toBeLessThan(workDirIndex);
    expect(preflightIndex).toBeLessThan(curlDownloadIndex);
    expect(installer).toContain('--head "${ARCHIVE_URL}"');
    expect(installer).toContain("df --output=avail -B1");
    expect(installer).toContain("insufficient disk space to stage Agy ACP component");
    expect(installer).toContain("AGENT_BRIDGE_AGY_ACP_DISK_SAFETY_FACTOR");
    expect(installer).toContain("--print-required-bytes");
    expect(installer.indexOf('printf \'%s\\n\' "${required_bytes}"')).toBeLessThan(workDirIndex);
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
    expect(workflow).toContain("scripts/install-cursor-acp.sh");
    expect(workflow).toContain("for (const component of manifest.host_components ?? [])");
    expect(workflow).not.toContain('find((entry) => entry.id === "voice-stt")');
  });
});
