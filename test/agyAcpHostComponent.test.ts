import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getLockedAcpRegistryEntry } from "../src/providers/acpRegistry.js";

const repoRoot = resolve(import.meta.dirname, "..");

describe("Agy ACP managed host component", () => {
  it("declares a release host component owned by the transactional activation lifecycle", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      agentBridge?: { hostComponents?: Array<{ id?: string; installer?: string; phase_protocol?: number }> };
    };
    expect(pkg.agentBridge?.hostComponents).toContainEqual({
      id: "agy-acp",
      installer: "scripts/install-agy-acp.sh",
      phase_protocol: 1,
    });
  });

  describe("archive extraction (the snippet the installer actually runs)", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    const snippet = /python3 - "\$archive" "\$staging\/agy" <<'PY'\n([\s\S]*?)\nPY\n/.exec(installer)?.[1];

    function extract(members: string[]): { status: number | null; stderr: string; out: string } {
      const dir = mkdtempSync(resolve(tmpdir(), "agy-extract-"));
      try {
        const src = resolve(dir, "src");
        mkdirSync(src);
        for (const name of members) {
          const path = resolve(src, name);
          mkdirSync(resolve(path, ".."), { recursive: true });
          writeFileSync(path, `binary:${name}`);
        }
        const archive = resolve(dir, "a.tar.gz");
        execFileSync("tar", ["czf", archive, "-C", src, ...members]);
        const out = resolve(dir, "agy");
        const result = spawnSync("python3", ["-", archive, out], { input: snippet, encoding: "utf8" });
        return { status: result.status, stderr: result.stderr, out: existsSync(out) ? readFileSync(out, "utf8") : "" };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("is present in the installer", () => { expect(snippet).toBeTruthy(); });
    it("accepts the official 1.5.2 layout, where the executable is named `antigravity`", () => {
      expect(extract(["antigravity"])).toMatchObject({ status: 0, out: "binary:antigravity" });
    });
    it("still accepts a single `agy` member", () => {
      expect(extract(["agy"])).toMatchObject({ status: 0, out: "binary:agy" });
    });
    it("rejects an archive with no recognised executable", () => {
      expect(extract(["README"]).stderr).toContain("expected one official agy executable");
    });
    it("rejects an ambiguous archive with more than one executable", () => {
      expect(extract(["antigravity", "bin/agy"]).stderr).toContain("expected one official agy executable");
    });
  });

  it("installs only the pinned official CLI binary without the legacy .par/harness", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    expect(installer).toContain("dist/providers/acpRegistry.locked.json");
    expect(installer).toContain('get("agy")');
    expect(installer).toContain('binary.get("sha256")');
    expect(installer).toContain("host_component_status=");
    expect(installer).toContain("binarySha256");
    expect(installer).toContain("archiveSha256");
    expect(installer).toContain("release-locked Agy CLI archive checksum mismatch");
    expect(installer).toContain("expected one official agy executable");
    expect(installer).toContain("tarfile.open");
    expect(installer).not.toContain("localharness_external");
    expect(installer).not.toContain("agy_acp_server.par");
    expect(installer).not.toMatch(/antigravity-acp@\d/);
  });

  it("reads release-locked metadata without executing a runtime-user Node binary as root", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    expect(installer).toContain("acpRegistry.locked.json");
    expect(installer).toContain("json.load");
    expect(installer).not.toContain("node --input-type=module");
  });

  it("exports immutable ACP registry data for root installers", () => {
    const outputDir = mkdtempSync(resolve(tmpdir(), "agent-bridge-registry-export-"));
    const output = resolve(outputDir, "registry.json");
    try {
      execFileSync(resolve(repoRoot, "node_modules/.bin/tsx"), [
        resolve(repoRoot, "scripts/exportAcpRegistry.ts"), "--output", output,
      ]);
      const document = JSON.parse(readFileSync(output, "utf8")) as {
        schema_version: number;
        providers: Record<string, unknown>;
      };
      expect(document.schema_version).toBe(1);
      expect(document.providers.agy).toEqual(getLockedAcpRegistryEntry("agy"));
      expect(document.providers.cursor).toEqual(getLockedAcpRegistryEntry("cursor"));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("exports the locked metadata before pruning and verifies it in the release archive", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release-artifact.yml"), "utf8");
    const exportAt = workflow.indexOf("scripts/exportAcpRegistry.ts --output dist/providers/acpRegistry.locked.json");
    const pruneAt = workflow.indexOf("npm prune --omit=dev");
    const manifestAt = workflow.indexOf("node scripts/releaseManifest.mjs");
    expect(exportAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(pruneAt);
    expect(exportAt).toBeLessThan(manifestAt);
    expect(workflow).toContain('test -f "$verify_root/dist/providers/acpRegistry.locked.json"');
  });

  it("streams large managed executables instead of buffering them in activation memory", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    expect(installer).toContain("shutil.copyfileobj");
    expect(installer).toContain("stream.read(1024 * 1024)");
    expect(installer).toContain("bundle.extractfile(matches[0])");
    expect(installer).not.toContain(".read_bytes()");
    expect(installer).not.toContain("bundle.extractall(");
  });

  it("checks disk headroom against the remote archive size before downloading or staging", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    const preflightIndex = installer.indexOf("remote_length=");
    const workDirIndex = installer.indexOf('work="$(mktemp -d');
    const curlDownloadIndex = installer.indexOf('--output "$archive"');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(workDirIndex).toBeGreaterThan(-1);
    expect(curlDownloadIndex).toBeGreaterThan(-1);
    // The disk-space check must run before any staging directory is created
    // or bytes are downloaded, so a failed check never leaves temporary
    // material behind and never races a doomed download.
    expect(preflightIndex).toBeLessThan(workDirIndex);
    expect(preflightIndex).toBeLessThan(curlDownloadIndex);
    expect(installer).toContain('--head "$ARCHIVE_URL"');
    expect(installer).toContain("df --output=avail -B1");
    expect(installer).toContain("insufficient disk space to stage Agy CLI component");
    expect(installer).toContain("AGENT_BRIDGE_AGY_ACP_DISK_SAFETY_FACTOR");
    expect(installer).toContain("--print-required-bytes");
    expect(installer.indexOf('printf \'%s\\n\' "$required_bytes"')).toBeLessThan(workDirIndex);
  });

  it("keeps the installed binary path traversable by the unprivileged runtime user", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install-agy-acp.sh"), "utf8");
    expect(installer).toContain('VERSION_DIR="$ROOT/components/$VERSION"');
    expect(installer).toContain('normalize_runtime_dir "$VERSION_DIR"');
    expect(installer).toContain('normalize_runtime_dir "$COMPONENT_DIR"');
    expect(installer).toContain('chmod 0755 "$path"');
    expect(installer).toContain('stat -c \'%u:%g:%a\' "$VERSION_DIR"');
    expect(installer).toContain('stat -c \'%u:%g:%a\' "$COMPONENT_DIR"');
  });

  it("packages the installer and verifies every declared host component generically", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release-artifact.yml"), "utf8");
    expect(workflow).toContain("scripts/install-agy-acp.sh");
    expect(workflow).toContain("scripts/install-cursor-acp.sh");
    expect(workflow).toContain("for (const component of manifest.host_components ?? [])");
    expect(workflow).not.toContain('find((entry) => entry.id === "voice-stt")');
  });
});
