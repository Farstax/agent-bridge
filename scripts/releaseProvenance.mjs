import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Walks the archive already extracted from the completed, already-hashed release tarball.
// GNU tar hardlinks (npm's node_modules dedup layout) are materialized as ordinary regular
// files on extraction, so they need no special handling here — the filesystem resolves them
// for us. This replaces parsing `tar --list --verbose` text, which cannot see real file
// content or symlink targets and has repeatedly drifted from tar's actual output format.
function walk(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const absolute = join(current, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isDirectory()) return walk(root, absolute);
      if (stat.isSymbolicLink()) return [{ path, mode, type: "symlink", target: readlinkSync(absolute) }];
      if (stat.isFile()) return [{ path, mode, type: "file", sha256: sha256File(absolute), size: stat.size }];
      throw new Error(`unsupported archive entry type: ${path}`);
    });
}

export function buildReleaseProvenance({
  targetCommit,
  targetTree,
  builderCommit,
  workflowBlob,
  workflowSha256,
  manifestToolSha256,
  manifest,
  archive,
  archiveMembers,
  verifyRoot,
  provenanceTool,
  nodeVersion,
  platform,
  arch,
}) {
  for (const [name, value] of Object.entries({ targetCommit, targetTree, builderCommit, workflowBlob })) {
    if (!SHA.test(value)) throw new Error(`${name} must be a full lowercase Git SHA`);
  }
  for (const [name, value] of Object.entries({ workflowSha256, manifestToolSha256 })) {
    if (!SHA256.test(value)) throw new Error(`${name} must be a full lowercase SHA-256`);
  }

  const manifestData = JSON.parse(readFileSync(manifest, "utf8"));
  const manifestByPath = new Map(manifestData.files.map((file) => [file.path, file]));
  const extracted = walk(resolve(verifyRoot));
  const extractedByPath = new Map(extracted.map((entry) => [entry.path, entry]));

  for (const entry of extracted) {
    if (entry.path === "manifest.json") continue;
    const expected = manifestByPath.get(entry.path);
    if (!expected) throw new Error(`archive member not present in manifest: ${entry.path}`);
    if (entry.type === "symlink") {
      if (expected.type !== "symlink") throw new Error(`entry type mismatch: ${entry.path}`);
      if (expected.target !== entry.target) throw new Error(`symlink target mismatch: ${entry.path}`);
    } else {
      if (expected.type === "symlink") throw new Error(`entry type mismatch: ${entry.path}`);
      if (expected.sha256 !== entry.sha256 || expected.size !== entry.size) {
        throw new Error(`content hash mismatch: ${entry.path}`);
      }
    }
  }
  for (const path of manifestByPath.keys()) {
    if (!extractedByPath.has(path)) throw new Error(`manifest file not present in archive: ${path}`);
  }

  return {
    schema_version: 1,
    targetCommit,
    targetTree,
    builderCommit,
    workflowBlob,
    workflowSha256,
    manifestToolSha256,
    packageLockSha256: manifestData.package_lock_sha256,
    runtime: { node: nodeVersion, platform, arch },
    archiveSha256: sha256File(archive),
    archiveMembersSha256: sha256File(archiveMembers),
    manifestSha256: sha256File(manifest),
    provenanceToolSha256: sha256File(provenanceTool),
    modeInventory: extracted.map(({ path, mode, type }) => ({ path, mode, type })),
    executableEntries: extracted
      .filter(({ type, mode }) => type === "file" && Number.parseInt(mode, 8) & 0o111)
      .map(({ path, mode, type }) => ({ path, mode, type })),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const output = argument("--output");
  const required = [
    "--output",
    "--target-commit",
    "--target-tree",
    "--builder-commit",
    "--workflow-blob",
    "--workflow-sha256",
    "--manifest-tool-sha256",
    "--manifest",
    "--archive",
    "--archive-members",
    "--verify-root",
    "--provenance-tool",
  ];
  if (required.some((name) => !argument(name))) throw new Error(`usage: releaseProvenance.mjs ${required.join(" VALUE ")} VALUE`);
  const provenance = buildReleaseProvenance({
    targetCommit: argument("--target-commit"),
    targetTree: argument("--target-tree"),
    builderCommit: argument("--builder-commit"),
    workflowBlob: argument("--workflow-blob"),
    workflowSha256: argument("--workflow-sha256"),
    manifestToolSha256: argument("--manifest-tool-sha256"),
    manifest: argument("--manifest"),
    archive: argument("--archive"),
    archiveMembers: argument("--archive-members"),
    verifyRoot: argument("--verify-root"),
    provenanceTool: argument("--provenance-tool"),
    nodeVersion: argument("--node-version") ?? process.version,
    platform: argument("--platform") ?? process.platform,
    arch: argument("--arch") ?? process.arch,
  });
  writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o640 });
}
