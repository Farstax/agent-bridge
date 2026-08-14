import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{40}$/;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const absolute = join(current, entry.name);
      if (entry.name === "manifest.json" && current === root) return [];
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const resolvedTarget = resolve(current, target);
        if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
          throw new Error(`release artifact symlink escaped root: ${absolute} -> ${target}`);
        }
        return [{ path: relative(root, absolute).split(sep).join("/"), type: "symlink", target }];
      }
      if (entry.isDirectory()) return collectFiles(root, absolute);
      if (!entry.isFile()) throw new Error(`release artifact contains unsupported file: ${absolute}`);
      const path = relative(root, absolute).split(sep).join("/");
      if (!path || path.startsWith("../") || path.includes("/../")) {
        throw new Error(`release artifact path escaped root: ${path}`);
      }
      return [{ path, sha256: sha256File(absolute), size: stat.size }];
    });
}

const REQUIRED_SOURCE_TSX_ENTRYPOINTS = [
  "src/index.ts",
  "src/index-interactive.ts",
  "src/index-discord-interactive.ts",
  "src/index-health.ts",
];

// Derives the packaging strategy from the packaged package.json itself, not from any flag the
// (untrusted, target-controlled) build-target job might report — a commit either has a build
// script or it doesn't, and that's ground truth independent of what ran in CI.
function deriveBuildStrategy(packageJson) {
  return packageJson.scripts && packageJson.scripts.build ? "compiled" : "source-tsx";
}

function validateBuildStrategy(strategy, files, packageJson) {
  const regularFile = (file) => file.type !== "symlink";
  const hasDist = files.some((file) => file.path === "dist" || file.path.startsWith("dist/"));
  if (strategy === "compiled") {
    if (!files.some((file) => regularFile(file) && file.path.startsWith("dist/"))) {
      throw new Error("compiled artifact requires a regular file beneath dist/");
    }
    return;
  }
  if (hasDist) throw new Error("source-tsx artifact must not contain a dist directory");
  if (!(packageJson.dependencies && packageJson.dependencies.tsx)) {
    throw new Error("source-tsx artifact requires tsx as a production dependency");
  }
  const tsxCli = files.find((file) => file.path === "node_modules/tsx/dist/cli.mjs");
  if (!tsxCli) {
    throw new Error("source-tsx artifact is missing the tsx runtime CLI: node_modules/tsx/dist/cli.mjs");
  }
  if (!regularFile(tsxCli)) {
    throw new Error("source-tsx artifact requires a regular tsx runtime CLI: node_modules/tsx/dist/cli.mjs");
  }
  const tsconfig = files.find((file) => file.path === "tsconfig.json");
  if (!tsconfig) {
    throw new Error("source-tsx artifact is missing required runtime configuration: tsconfig.json");
  }
  if (!regularFile(tsconfig)) {
    throw new Error("source-tsx artifact requires a regular runtime configuration: tsconfig.json");
  }
  for (const entrypoint of REQUIRED_SOURCE_TSX_ENTRYPOINTS) {
    const sourceEntry = files.find((file) => file.path === entrypoint);
    if (!sourceEntry) {
      throw new Error(`source-tsx artifact is missing required runtime entrypoint: ${entrypoint}`);
    }
    if (!regularFile(sourceEntry)) {
      throw new Error(`source-tsx artifact requires a regular runtime entrypoint: ${entrypoint}`);
    }
  }
}

export function buildReleaseManifest({
  root, commit, tree, nodeVersion, platform, arch,
  builderCommit, builderWorkflowRun, builderWorkflowHead, databaseSchemaVersion,
}) {
  const artifactRoot = resolve(root);
  if (!SHA256.test(commit) || !SHA256.test(tree)) {
    throw new Error("commit and tree must be full lowercase 40-character Git SHAs");
  }
  const files = collectFiles(artifactRoot);
  if (!files.some((file) => file.path === "package-lock.json")) {
    throw new Error("release artifact is missing package-lock.json");
  }
  const packageJsonFile = files.find((file) => file.path === "package.json");
  if (!packageJsonFile) throw new Error("release artifact is missing package.json");
  const packageJson = JSON.parse(readFileSync(join(artifactRoot, "package.json"), "utf8"));
  const buildStrategy = deriveBuildStrategy(packageJson);
  validateBuildStrategy(buildStrategy, files, packageJson);

  const manifest = {
    schema_version: 1,
    commit,
    tree,
    build_strategy: buildStrategy,
    package_lock_sha256: files.find((file) => file.path === "package-lock.json").sha256,
    runtime: { node: nodeVersion, platform, arch },
    files,
  };
  if (builderCommit !== undefined || builderWorkflowRun !== undefined || builderWorkflowHead !== undefined) {
    if (!SHA256.test(builderCommit ?? "") || !SHA256.test(builderWorkflowHead ?? "") || !String(builderWorkflowRun ?? "").trim()) {
      throw new Error("builder provenance requires commit, workflow run and workflow head");
    }
    manifest.builder = {
      commit: builderCommit,
      workflow_run: String(builderWorkflowRun),
      workflow_head: builderWorkflowHead,
    };
  }
  if (databaseSchemaVersion !== undefined) {
    if (!Number.isInteger(databaseSchemaVersion) || databaseSchemaVersion < 1) {
      throw new Error("database schema version must be a positive integer");
    }
    manifest.database_schema_version = databaseSchemaVersion;
  }
  return manifest;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = argument("--root");
  const output = argument("--output");
  if (!root || !output) throw new Error("usage: releaseManifest.mjs --root DIR --output FILE");
  const manifest = buildReleaseManifest({
    root,
    commit: argument("--commit"),
    tree: argument("--tree"),
    nodeVersion: argument("--node-version") ?? process.version,
    platform: argument("--platform") ?? process.platform,
    arch: argument("--arch") ?? process.arch,
    builderCommit: argument("--builder-commit"),
    builderWorkflowRun: argument("--builder-workflow-run"),
    builderWorkflowHead: argument("--builder-workflow-head"),
    databaseSchemaVersion: argument("--database-schema-version") === undefined
      ? undefined : Number(argument("--database-schema-version")),
  });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });
}
