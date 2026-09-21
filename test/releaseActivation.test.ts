import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const OLD_COMMIT = "1".repeat(40);
const NEW_COMMIT = "2".repeat(40);

function makeRelease(root: string, commit: string): string {
  const release = join(root, "releases", commit);
  const releases = join(root, "releases");
  execFileSync("mkdir", ["-p", release]);
  writeFileSync(join(release, "manifest.json"), JSON.stringify({ schema_version: 1, commit }));
  writeFileSync(join(release, "entrypoint"), "immutable\n");
  chmodSync(join(release, "manifest.json"), 0o444);
  chmodSync(join(release, "entrypoint"), 0o444);
  chmodSync(release, 0o555);
  chmodSync(releases, 0o755);
  return release;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sha256Zeros(size: number): string {
  const hasher = createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  for (let remaining = size; remaining > 0; remaining -= chunk.length) {
    hasher.update(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining));
  }
  return hasher.digest("hex");
}

function makeStrictLargeRelease(root: string, commit: string): string {
  const release = join(root, "releases", commit);
  execFileSync("mkdir", ["-p", join(release, "scripts")]);

  const packageLock = '{"lockfileVersion":3}\n';
  const rolloutDb = "export {};\n";
  const rolloutDbImpl = "export {};\n";
  const largeSize = 64 * 1024 * 1024;
  const largePath = join(release, "large-payload.bin");

  writeFileSync(join(release, "package-lock.json"), packageLock);
  writeFileSync(join(release, "scripts", "rollout-db.ts"), rolloutDb);
  writeFileSync(join(release, "scripts", "rollout-db-impl.ts"), rolloutDbImpl);
  writeFileSync(largePath, "");
  truncateSync(largePath, largeSize);

  const files = [
    { path: "package-lock.json", sha256: sha256(packageLock), size: Buffer.byteLength(packageLock) },
    { path: "scripts/rollout-db.ts", sha256: sha256(rolloutDb), size: Buffer.byteLength(rolloutDb) },
    { path: "scripts/rollout-db-impl.ts", sha256: sha256(rolloutDbImpl), size: Buffer.byteLength(rolloutDbImpl) },
    { path: "large-payload.bin", sha256: sha256Zeros(largeSize), size: largeSize },
  ];
  writeFileSync(join(release, "manifest.json"), JSON.stringify({
    schema_version: 1,
    commit,
    build_strategy: "compiled",
    package_lock_sha256: files[0].sha256,
    files,
  }));

  for (const path of [
    join(release, "package-lock.json"),
    join(release, "scripts", "rollout-db.ts"),
    join(release, "scripts", "rollout-db-impl.ts"),
    largePath,
    join(release, "manifest.json"),
  ]) chmodSync(path, 0o444);
  chmodSync(join(release, "scripts"), 0o555);
  chmodSync(release, 0o555);
  chmodSync(join(root, "releases"), 0o755);
  return release;
}

function activate(root: string, expectedCommit: string): string {
  return execFileSync("python3", [
    "scripts/release-activate.py",
    "--release-root", join(root, "releases"),
    "--current", join(root, "releases", "current"),
    "--expected-commit", expectedCommit,
  ], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_RELEASE_ACTIVATE_TEST: "1" },
  });
}

function validateOnly(root: string, expectedCommit: string): string {
  return execFileSync("python3", ["scripts/release-activate.py", "--validate-only", "--release-root", join(root, "releases"), "--current", join(root, "releases", "current"), "--expected-commit", expectedCommit], { encoding: "utf8", env: { ...process.env, AGENT_BRIDGE_RELEASE_ACTIVATE_TEST: "1" } });
}

describe("atomic current release activation", () => {
  it("publishes a validated release through an atomic current symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    makeRelease(root, OLD_COMMIT);
    makeRelease(root, NEW_COMMIT);
    symlinkSync(OLD_COMMIT, join(root, "releases", "current"));

    expect(activate(root, NEW_COMMIT)).toContain(`activated ${NEW_COMMIT}`);
    expect(lstatSync(join(root, "releases", "current")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "releases", "current", "manifest.json"), "utf8")).toContain(NEW_COMMIT);
  });

  it("fails closed without replacing an unexpected current path", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    makeRelease(root, NEW_COMMIT);
    writeFileSync(join(root, "releases", "current"), "not a pointer\n");

    expect(() => activate(root, NEW_COMMIT)).toThrow();
    expect(existsSync(join(root, "releases", NEW_COMMIT))).toBe(true);
    expect(lstatSync(join(root, "releases", "current")).isSymbolicLink()).toBe(false);
  });

  it("rejects a writable release before changing current", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    const release = makeRelease(root, NEW_COMMIT);
    chmodSync(join(release, "entrypoint"), 0o644);

    expect(() => activate(root, NEW_COMMIT)).toThrow();
    expect(existsSync(join(root, "releases", "current"))).toBe(false);
  });

  it("rejects a same-target pointer replacement as a no-op activation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    makeRelease(root, NEW_COMMIT);
    symlinkSync(NEW_COMMIT, join(root, "releases", "current"));

    expect(() => activate(root, NEW_COMMIT)).toThrow(/same target|no-op/i);
    expect(readlinkSync(join(root, "releases", "current"))).toBe(NEW_COMMIT);
  });

  it("validates a large immutable release within a bounded memory envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-memory-"));
    const release = makeStrictLargeRelease(root, NEW_COMMIT);
    const script = [
      "import importlib.machinery, importlib.util, os, pathlib, resource, sys",
      "loader = importlib.machinery.SourceFileLoader('release_activate', 'scripts/release-activate.py')",
      "spec = importlib.util.spec_from_loader(loader.name, loader)",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "with open('/proc/self/status', encoding='utf-8') as stream:",
      "    vm_kb = next(int(line.split()[1]) for line in stream if line.startswith('VmSize:'))",
      "limit = (vm_kb + 32 * 1024) * 1024",
      "resource.setrlimit(resource.RLIMIT_AS, (limit, limit))",
      "module.validate_release(pathlib.Path(sys.argv[1]), sys.argv[2], strict=True)",
    ].join("\n");

    expect(() => execFileSync("python3", ["-c", script, release, NEW_COMMIT], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_RELEASE_ACTIVATE_TEST: "1" },
    })).not.toThrow();
  }, 20_000);

  it("keeps normal activation to one release-validation pass", () => {
    const source = readFileSync("scripts/release-activate.py", "utf8");
    expect(source).toContain("validate_release(release, expected_commit, strict=production_mode())");
    const main = source.slice(source.indexOf("def main() -> int:"));
    expect(main).toContain("if args.validate_only:");
    expect(main).toContain("print(activate(args.release_root, args.current, args.expected_commit))");
    expect(main.match(/validate_release\(args\.release_root \/ args\.expected_commit/g) ?? []).toHaveLength(1);
  });

  it("rejects a release whose manifest paths do not match the filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    const release = makeRelease(root, NEW_COMMIT);
    chmodSync(join(release, "manifest.json"), 0o644);
    writeFileSync(join(release, "manifest.json"), JSON.stringify({
      schema_version: 1,
      commit: NEW_COMMIT,
      tree: "3".repeat(40),
      package_lock_sha256: "4".repeat(64),
      files: [{ path: "missing-helper.ts", sha256: "5".repeat(64), size: 1 }],
    }));
    chmodSync(join(release, "manifest.json"), 0o444);

    expect(() => validateOnly(root, NEW_COMMIT)).toThrow(/manifest/i);
    expect(existsSync(join(root, "releases", "current"))).toBe(false);
  });
});
