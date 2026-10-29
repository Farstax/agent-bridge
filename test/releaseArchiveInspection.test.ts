import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const stagePath = resolve(process.cwd(), "scripts/release-stage.py");
const installPath = resolve(process.cwd(), "scripts/agent-bridge-install.py");
const deployer = resolve(process.cwd(), "scripts/agent-bridge-deploy.py");
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const roots: string[] = [];

function relax(root: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(root, 0o755);
    for (const name of readdirSync(root)) relax(join(root, name));
    return;
  }
  chmodSync(root, 0o644);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    relax(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function probe(body: string): unknown {
  const parent = mkdtempSync(join(tmpdir(), "agent-bridge-inspect-"));
  roots.push(parent);
  const source = `
import importlib.util, io, json, os, pathlib, shutil, sys, tarfile, hashlib
parent = pathlib.Path(${JSON.stringify(parent)})
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module
stage = load("release_stage_inspection", ${JSON.stringify(stagePath)})
install = load("install_inspection", ${JSON.stringify(installPath)})
${body}
`;
  return JSON.parse(execFileSync("python3", ["-c", source], { encoding: "utf8" }));
}

describe("single archive inspection and candidate staging", () => {
  it("verifies an archive without creating an extracted tree, then stages one reusable candidate", () => {
    const result = probe(`
os.environ["AGENT_BRIDGE_RELEASE_STAGE_TEST"] = "1"
os.environ.pop("AGENT_BRIDGE_RELEASE_STAGE_TEST_AVAILABLE_BYTES", None)
lock = b"lock\\n"
payload = b"runtime\\n"
qualification = (json.dumps({"commit": "${COMMIT}", "tree": "${TREE}"}) + "\\n").encode()
root = parent / "payload"
root.mkdir()
(root / "package-lock.json").write_bytes(lock)
(root / "runtime.js").write_bytes(payload)
(root / "qualification-evidence.json").write_bytes(qualification)
(root / "bin").mkdir()
os.symlink("../runtime.js", root / "bin" / "runtime")
def digest(value):
    return hashlib.sha256(value).hexdigest()
manifest = {
    "schema_version": 1,
    "commit": "${COMMIT}",
    "tree": "${TREE}",
    "files": [
        {"path": "package-lock.json", "sha256": digest(lock), "size": len(lock)},
        {"path": "runtime.js", "sha256": digest(payload), "size": len(payload)},
        {"path": "qualification-evidence.json", "sha256": digest(qualification), "size": len(qualification)},
        {"path": "bin/runtime", "type": "symlink", "target": "../runtime.js"},
    ],
    "package_lock_sha256": digest(lock),
}
(root / "manifest.json").write_text(json.dumps(manifest) + "\\n")
archive = parent / "release.tar.gz"
with tarfile.open(archive, "w:gz") as bundle:
    for name in ("manifest.json", "package-lock.json", "runtime.js", "qualification-evidence.json", "bin/runtime"):
        bundle.add(root / name, arcname=name)
before = sorted(os.listdir(parent))
inspected = stage.inspect_archive(archive)
after_inspect = sorted(os.listdir(parent))
release_root = parent / "releases"
message = stage.stage(archive, release_root, "${COMMIT}", inspected["archive_sha256"])
again = stage.stage(archive, release_root, "${COMMIT}", inspected["archive_sha256"])
names = sorted(os.listdir(release_root))
print(json.dumps({
    "unchanged": before == after_inspect,
    "commit": inspected["manifest"]["commit"],
    "qualification": json.loads(inspected["qualification_text"])["tree"],
    "fileCount": inspected["file_count"],
    "message": message,
    "again": again,
    "names": names,
    "runtime": (release_root / "${COMMIT}" / "runtime.js").read_text(),
}))
`) as { unchanged: boolean; commit: string; qualification: string; fileCount: number; message: string; again: string; names: string[]; runtime: string };

    expect(result.unchanged).toBe(true);
    expect(result.commit).toBe(COMMIT);
    expect(result.qualification).toBe(TREE);
    expect(result.fileCount).toBe(4);
    expect(result.message).toBe(`staged ${COMMIT}`);
    expect(result.again).toBe(`already staged ${COMMIT}`);
    expect(result.names.filter((name) => name.startsWith(".staging-"))).toEqual([]);
    expect(result.runtime).toBe("runtime\n");
  });

  it("refuses unsafe paths, escaped symlinks and hash mismatches without leaving a tree", () => {
    const result = probe(`
def attempt(build):
    directory = parent / "case"
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir()
    archive = directory / "bad.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        build(bundle)
    before = sorted(path.name for path in directory.iterdir())
    error = ""
    try:
        stage.inspect_archive(archive)
    except Exception as exc:
        error = str(exc)
    after = sorted(path.name for path in directory.iterdir())
    return {"error": error, "same": before == after}

def add_bytes(bundle, name, payload):
    info = tarfile.TarInfo(name)
    info.size = len(payload)
    bundle.addfile(info, io.BytesIO(payload))

unsafe = attempt(lambda bundle: add_bytes(bundle, "../evil", b"x"))
link = tarfile.TarInfo("bin/escape")
link.type = tarfile.SYMTYPE
link.linkname = "../../etc/passwd"
escaped = attempt(lambda bundle: bundle.addfile(link))
lock = b"lock\\n"
payload = b"runtime\\n"
manifest = {
    "schema_version": 1,
    "commit": "${COMMIT}",
    "tree": "${TREE}",
    "files": [{"path": "package-lock.json", "sha256": hashlib.sha256(lock).hexdigest(), "size": len(lock)},
              {"path": "runtime.js", "sha256": hashlib.sha256(b"other\\n").hexdigest(), "size": len(payload)}],
    "package_lock_sha256": hashlib.sha256(lock).hexdigest(),
}
def mismatched(bundle):
    add_bytes(bundle, "manifest.json", (json.dumps(manifest) + "\\n").encode())
    add_bytes(bundle, "package-lock.json", lock)
    add_bytes(bundle, "runtime.js", payload)
mismatch = attempt(mismatched)
print(json.dumps({"unsafe": unsafe, "escaped": escaped, "mismatch": mismatch}))
`) as { unsafe: { error: string; same: boolean }; escaped: { error: string; same: boolean }; mismatch: { error: string; same: boolean } };

    expect(result.unsafe.error).toMatch(/unsafe archive path/);
    expect(result.unsafe.same).toBe(true);
    expect(result.escaped.error).toMatch(/symlink escaped/);
    expect(result.escaped.same).toBe(true);
    expect(result.mismatch.error).toMatch(/hash or size mismatch/);
    expect(result.mismatch.same).toBe(true);
  });

  it("refuses a candidate when the safety reserve does not fit and keeps the snapshot across a later mutation", () => {
    const result = probe(`
os.environ["AGENT_BRIDGE_RELEASE_STAGE_TEST"] = "1"
lock = b"lock\\n"
payload = b"runtime\\n"
manifest = {
    "schema_version": 1,
    "commit": "${COMMIT}",
    "tree": "${TREE}",
    "files": [
        {"path": "package-lock.json", "sha256": hashlib.sha256(lock).hexdigest(), "size": len(lock)},
        {"path": "runtime.js", "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)},
    ],
    "package_lock_sha256": hashlib.sha256(lock).hexdigest(),
}
archive = parent / "release.tar.gz"
with tarfile.open(archive, "w:gz") as bundle:
    for name, payload in (("manifest.json", (json.dumps(manifest) + "\\n").encode()), ("package-lock.json", lock), ("runtime.js", payload)):
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        bundle.addfile(info, io.BytesIO(payload))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
release_root = parent / "releases"
os.environ["AGENT_BRIDGE_RELEASE_STAGE_TEST_AVAILABLE_BYTES"] = "1"
error = ""
try:
    stage.stage(archive, release_root, "${COMMIT}", digest)
except Exception as exc:
    error = str(exc)
refused = sorted(os.listdir(release_root))
os.environ.pop("AGENT_BRIDGE_RELEASE_STAGE_TEST_AVAILABLE_BYTES")
shutil.rmtree(release_root)
os.environ["AGENT_BRIDGE_RELEASE_STAGE_TEST_MUTATE_ARCHIVE"] = "1"
message = stage.stage(archive, release_root, "${COMMIT}", digest)
runtime = (release_root / "${COMMIT}" / "runtime.js").read_bytes().decode()
mutated = archive.read_bytes()
install.discard_staged_release(release_root, "${COMMIT}")
second_root = parent / "again"
os.environ.pop("AGENT_BRIDGE_RELEASE_STAGE_TEST_MUTATE_ARCHIVE")
# The mutated archive is no longer a valid snapshot source. Rebuild and cycle twice.
archive.write_bytes(b"")
with tarfile.open(archive, "w:gz") as bundle:
    for name, payload in (("manifest.json", (json.dumps(manifest) + "\\n").encode()), ("package-lock.json", lock), ("runtime.js", payload)):
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        bundle.addfile(info, io.BytesIO(payload))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
first = stage.stage(archive, second_root, "${COMMIT}", digest)
install.discard_staged_release(second_root, "${COMMIT}")
second = stage.stage(archive, second_root, "${COMMIT}", digest)
print(json.dumps({
    "error": error,
    "refused": refused,
    "message": message,
    "runtime": runtime,
    "mutated": mutated.decode(),
    "first": first,
    "second": second,
    "left": sorted(os.listdir(second_root)),
}))
`) as { error: string; refused: string[]; message: string; runtime: string; mutated: string; first: string; second: string; left: string[] };

    expect(result.error).toContain("release_disk_space_insufficient");
    expect(result.refused.filter((name) => name.startsWith(".staging-") || name === COMMIT)).toEqual([]);
    expect(result.message).toBe(`staged ${COMMIT}`);
    expect(result.runtime).toBe("runtime\n");
    expect(result.mutated).toBe("mutated after hashing");
    expect(result.first).toBe(`staged ${COMMIT}`);
    expect(result.second).toBe(`staged ${COMMIT}`);
    expect(result.left).toEqual([`.${COMMIT}.staging-provenance.json`, COMMIT]);
  });

  it("keeps a qualification mismatch as a deployment validation failure", () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "agent-bridge-qualification-"));
    roots.push(archiveDir);
    const built = probe(`
lock = b"lock\\n"
payload = b"runtime\\n"
qualification = (json.dumps({"commit": "${"c".repeat(40)}", "tree": "${TREE}"}) + "\\n").encode()
manifest = {
    "schema_version": 1,
    "commit": "${COMMIT}",
    "tree": "${TREE}",
    "files": [
        {"path": "package-lock.json", "sha256": hashlib.sha256(lock).hexdigest(), "size": len(lock)},
        {"path": "runtime.js", "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)},
        {"path": "qualification-evidence.json", "sha256": hashlib.sha256(qualification).hexdigest(), "size": len(qualification)},
    ],
    "package_lock_sha256": hashlib.sha256(lock).hexdigest(),
}
archive = parent / "release.tar.gz"
with tarfile.open(archive, "w:gz") as bundle:
    for name, body in (
        ("manifest.json", (json.dumps(manifest) + "\\n").encode()),
        ("package-lock.json", lock),
        ("runtime.js", payload),
        ("qualification-evidence.json", qualification),
    ):
        info = tarfile.TarInfo(name)
        info.size = len(body)
        bundle.addfile(info, io.BytesIO(body))
approval = {
    "environment": "production-content-crawler",
    "target_commit": "${COMMIT}",
    "release_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "approval_reference": "issue-1100",
    "expires_at": "2099-07-28T23:59:59Z",
}
(parent / "approval.json").write_text(json.dumps(approval) + "\\n")
os.chmod(parent / "approval.json", 0o600)
print(json.dumps({"archive": str(archive), "approval": str(parent / "approval.json")}))
`) as { archive: string; approval: string };
    const result = spawnSync("python3", [deployer, "--release", built.archive, "--approval", built.approval, "--validate-only"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/qualification evidence does not match/);
  });
});
