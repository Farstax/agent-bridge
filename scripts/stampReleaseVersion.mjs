import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { releaseCompatibilityVersion } from "./releaseVersion.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function stampReleaseCompatibilityVersion(root, releaseTag) {
  const version = releaseCompatibilityVersion(releaseTag);
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);

  packageJson.version = version;
  packageLock.version = version;
  if (packageLock.packages && packageLock.packages[""]) {
    packageLock.packages[""].version = version;
  }

  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);
  return version;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = argument("--root");
  const releaseTag = argument("--release-tag");
  if (!root || !releaseTag) {
    throw new Error("usage: stampReleaseVersion.mjs --root DIR --release-tag release-YYYY.MM.DD-N");
  }
  process.stdout.write(`${stampReleaseCompatibilityVersion(root, releaseTag)}\n`);
}
