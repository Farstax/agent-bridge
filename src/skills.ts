/**
 * PURPOSE: Shared skills catalog installation, verification, and uninstall helpers.
 * INPUTS: Bundled skill folders, a target home directory, lockfile contents, and link mode options.
 * OUTPUTS: Installed skill folders, native CLI skill links or copies, lockfile records, and verification results.
 * NEIGHBORS: scripts/skill-manager.ts, scripts/install.sh
 * LOGIC: Maintains a shared ~/.agents/skills store, projects skills into native CLI skill directories, and preserves lockfile metadata and ownership.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillLinkMode = "symlink" | "copy";
export type SkillOwnership = "bundled" | "user";

export interface SkillCatalogEntry {
  name: string;
  version: string;
  description: string;
  path: string;
}

/**
 * Cursor also discovers Claude/Codex skill directories. When the same skill name
 * exists in multiple Cursor-visible locations, #552 observed Cursor preferring
 * the Claude-compatible copy. Managed Bridge skills therefore treat
 * `.cursor/skills/<name>/SKILL.md` as the canonical Cursor projection and keep
 * that ambiguity explicit rather than inventing a second precedence layer.
 */
export const CURSOR_SKILL_DISCOVERY_NOTE =
  "Canonical Cursor Skill projection is ~/.cursor/skills/<name>/SKILL.md. " +
  "Cursor may also discover .claude/skills and .codex/skills; duplicate names " +
  "are ambiguous and were observed to prefer the Claude-compatible copy (#552).";

export interface SkillPaths {
  homeDir: string;
  agentsSkillsDir: string;
  codexSkillsDir: string;
  geminiSkillsDir: string;
  claudeSkillsDir: string;
  cursorSkillsDir: string;
  lockfilePath: string;
}

export interface InstallSkillOptions {
  homeDir?: string;
  repoRoot?: string;
  force?: boolean;
  linkMode?: SkillLinkMode;
  ownership?: SkillOwnership;
  now?: Date;
}

export interface VerifySkillOptions {
  homeDir?: string;
  repoRoot?: string;
  fix?: boolean;
}

export interface UninstallSkillOptions {
  homeDir?: string;
  expectedOwnership?: SkillOwnership;
}

export interface VerifySkillResult {
  ok: boolean;
  errors: string[];
  repaired: string[];
}

type SkillLockRecord = {
  source?: string;
  sourceType?: string;
  skillPath?: string;
  skillFolderHash?: string;
  linkMode?: SkillLinkMode;
  ownership?: SkillOwnership;
  installedAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type SkillLockfile = {
  version?: number;
  skills?: Record<string, SkillLockRecord>;
  [key: string]: unknown;
};

type LegacySkillManifest = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(moduleDir, "..");
const unversionedSkill = "unversioned";
const skillLockVersion = 4;

// Frozen at the v4 ownership migration. Never derive this from the current
// catalog: a later release may add a bundled name that already belongs to a
// legacy user-authored v3 skill, and that collision must remain user-owned.
const legacyBundledSkillsAtOwnershipV4 = new Set([
  "advisor",
  "autonomous-work",
  "cli-auth-telegram",
  "delivery-directives",
  "git-sandbox",
  "health-troubleshooting",
  "manage-mcp",
  "manage-skills",
  "red-green-refactor-tdd",
  "release-readiness-review",
  "requirements-to-acceptance",
  "risk-based-test-strategy",
  "systematic-debugging",
  "ui-engineering",
]);

export function getSharedSkillsHomeDir(env: { SHARED_MEMORY_HOME?: string; HOME?: string } = process.env, fallbackHome = homedir()): string {
  return env.SHARED_MEMORY_HOME || env.HOME || fallbackHome;
}

export function resolveSkillPaths(homeDir = getSharedSkillsHomeDir()): SkillPaths {
  return {
    homeDir,
    agentsSkillsDir: join(homeDir, ".agents", "skills"),
    codexSkillsDir: join(homeDir, ".codex", "skills"),
    geminiSkillsDir: join(homeDir, ".gemini", "antigravity-cli", "skills"),
    claudeSkillsDir: join(homeDir, ".claude", "skills"),
    cursorSkillsDir: join(homeDir, ".cursor", "skills"),
    lockfilePath: join(homeDir, ".agents", ".skill-lock.json"),
  };
}

export function listLocalCatalog(repoRoot = defaultRepoRoot): SkillCatalogEntry[] {
  const skillsDir = join(repoRoot, "skills");
  if (!existsSync(skillsDir)) return [];

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readCatalogEntry(join(skillsDir, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function installSkillGlobal(skillName: string, options: InstallSkillOptions = {}): void {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const paths = resolveSkillPaths(options.homeDir);
  const linkMode = options.linkMode ?? "symlink";
  const requestedOwnership = options.ownership ?? "bundled";
  const sourceDir = join(repoRoot, "skills", skillName);
  if (!existsSync(sourceDir)) throw new Error(`Unknown bundled skill: ${skillName}`);
  validateLinkMode(linkMode);
  readCatalogEntry(sourceDir);

  mkdirSync(paths.agentsSkillsDir, { recursive: true });
  const destDir = join(paths.agentsSkillsDir, skillName);
  const destinationExists = existsSync(destDir);
  // Force may repair a corrupt lock only when no canonical skill can be lost.
  // Existing canonical content requires readable ownership metadata.
  const lockfile = readLockfile(paths.lockfilePath, { force: Boolean(options.force && !destinationExists) });
  const previous = lockfile.skills?.[skillName];
  if (previous) {
    const existingOwnership = resolveSkillOwnership(skillName, previous);
    if (existingOwnership !== requestedOwnership) {
      throw new Error(`Refusing to replace ${existingOwnership}-owned skill with ${requestedOwnership}-owned skill: ${skillName}`);
    }
  } else if (destinationExists && requestedOwnership === "bundled") {
    throw new Error(`Refusing to replace unowned shared skill path with bundled skill: ${skillName}`);
  }

  if (destinationExists) {
    const currentHash = hashDirectory(destDir);
    const sourceHash = hashDirectory(sourceDir);
    if (!options.force) throw new Error(`Skill already installed: ${skillName}`);
    if (currentHash !== sourceHash) rmSync(destDir, { recursive: true, force: true });
  }
  if (!existsSync(destDir)) cpSync(sourceDir, destDir, { recursive: true });

  const installedHash = hashDirectory(destDir);
  const now = (options.now ?? new Date()).toISOString();
  lockfile.version = Math.max(lockfile.version ?? 0, skillLockVersion);
  lockfile.skills ??= {};
  lockfile.skills[skillName] = {
    ...(previous ?? {}),
    source: "shared-local",
    sourceType: "local",
    skillPath: `skills/${skillName}/SKILL.md`,
    skillFolderHash: installedHash,
    linkMode,
    ownership: requestedOwnership,
    installedAt: typeof previous?.installedAt === "string" ? previous.installedAt : now,
    updatedAt: now,
  };

  for (const nativeDir of nativeSkillDirs(paths)) {
    projectNativeSkill({ skillName, sharedDir: destDir, nativeDir, linkMode, force: options.force });
  }

  writeJsonAtomic(paths.lockfilePath, lockfile);
}

export function verifySkillGlobal(skillName?: string, options: VerifySkillOptions = {}): VerifySkillResult {
  const paths = resolveSkillPaths(options.homeDir);
  const errors: string[] = [];
  const repaired: string[] = [];
  let lockfile: SkillLockfile;
  try {
    lockfile = readLockfile(paths.lockfilePath, { force: false });
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], repaired };
  }

  const names = skillName ? [skillName] : Object.keys(lockfile.skills ?? {}).sort();
  for (const name of names) {
    const record = lockfile.skills?.[name];
    if (!record) {
      errors.push(`Skill is not registered in lockfile: ${name}`);
      continue;
    }
    let ownership: SkillOwnership;
    try {
      ownership = resolveSkillOwnership(name, record);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const sharedDir = join(paths.agentsSkillsDir, name);
    if (!existsSync(sharedDir)) {
      errors.push(`Installed skill folder is missing: ${sharedDir}`);
      continue;
    }
    const sharedHash = hashDirectory(sharedDir);
    if (record.skillFolderHash && record.skillFolderHash !== sharedHash) {
      errors.push(`Installed skill hash mismatch: ${name}`);
    }

    const linkMode = record.linkMode === "copy" ? "copy" : "symlink";
    for (const nativeDir of nativeSkillDirs(paths)) {
      const nativePath = join(nativeDir, name);
      const problem = verifyNativeSkill({ nativePath, sharedDir, linkMode, expectedHash: sharedHash });
      if (!problem) continue;
      if (options.fix && ownership === "bundled") {
        projectNativeSkill({ skillName: name, sharedDir, nativeDir, linkMode, force: true });
        repaired.push(nativePath);
      } else if (options.fix) {
        errors.push(`${problem}; refusing generic --fix for user-owned skill ${name}; use project-user`);
      } else {
        errors.push(problem);
      }
    }
  }

  return { ok: errors.length === 0, errors, repaired };
}

export function uninstallSkillGlobal(skillName: string, options: UninstallSkillOptions = {}): void {
  const paths = resolveSkillPaths(options.homeDir);
  const lockfile = readLockfile(paths.lockfilePath, { force: false });
  const record = lockfile.skills?.[skillName];
  if (!record) throw new Error(`Skill is not registered in lockfile: ${skillName}`);
  const expectedOwnership = options.expectedOwnership ?? "bundled";
  const ownership = resolveSkillOwnership(skillName, record);
  if (ownership !== expectedOwnership) {
    throw new Error(`Refusing to uninstall ${ownership}-owned skill as ${expectedOwnership}-owned skill: ${skillName}`);
  }

  for (const nativeDir of nativeSkillDirs(paths)) {
    rmSync(join(nativeDir, skillName), { recursive: true, force: true });
  }
  rmSync(join(paths.agentsSkillsDir, skillName), { recursive: true, force: true });
  if (lockfile.skills) delete lockfile.skills[skillName];
  lockfile.version = Math.max(lockfile.version ?? 0, skillLockVersion);
  writeJsonAtomic(paths.lockfilePath, lockfile);
}

export function hashDirectory(dir: string): string {
  const hash = createHash("sha1");
  for (const file of listFilesRecursive(dir)) {
    const rel = relative(dir, file).split("\\").join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readCatalogEntry(skillDir: string): SkillCatalogEntry {
  const manifestPath = join(skillDir, "skill.json");
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`Missing SKILL.md: ${skillDir}`);

  const frontmatter = readSkillFrontmatter(skillPath);
  validateSkillName(frontmatter.name, skillPath);
  validateSkillDescription(frontmatter.description, skillPath);
  if (frontmatter.name !== basename(skillDir)) throw new Error(`Skill name does not match folder: ${skillDir}`);

  let version = unversionedSkill;
  if (existsSync(manifestPath)) {
    const manifest = readLegacySkillManifest(manifestPath);
    if (manifest.name !== undefined && manifest.name !== frontmatter.name) {
      throw new Error(`Skill manifest name does not match SKILL.md: ${skillDir}`);
    }
    if (manifest.version !== undefined) version = manifest.version;
  }

  return { name: frontmatter.name, version, description: frontmatter.description, path: skillDir };
}

function readSkillFrontmatter(skillPath: string): { name: string; description: string } {
  const frontmatter = readFileSync(skillPath, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) throw new Error(`SKILL.md frontmatter is invalid: ${skillPath}`);

  const name = readFrontmatterString(frontmatter, "name");
  const description = readFrontmatterString(frontmatter, "description");
  if (name === undefined || description === undefined) throw new Error(`SKILL.md frontmatter is invalid: ${skillPath}`);
  return { name, description };
}

function readFrontmatterString(frontmatter: string, key: string): string | undefined {
  const line = frontmatter.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}:`));
  if (!line) return undefined;
  const raw = line.slice(key.length + 1).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function validateSkillName(name: string, skillPath: string): void {
  if (name.length < 1 || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`SKILL.md frontmatter name is invalid: ${skillPath}`);
  }
}

function validateSkillDescription(description: string, skillPath: string): void {
  if (description.trim().length < 1 || description.length > 1024) {
    throw new Error(`SKILL.md frontmatter description is invalid: ${skillPath}`);
  }
}

function readLegacySkillManifest(manifestPath: string): { name?: string; version?: string } {
  let manifest: LegacySkillManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as LegacySkillManifest;
  } catch {
    throw new Error(`Invalid skill.json: ${manifestPath}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`Invalid skill.json: ${manifestPath}`);
  if (manifest.name !== undefined && typeof manifest.name !== "string") throw new Error(`Invalid skill.json: ${manifestPath}`);
  if (manifest.version !== undefined && (typeof manifest.version !== "string" || manifest.version.trim().length === 0)) {
    throw new Error(`Invalid skill.json: ${manifestPath}`);
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") throw new Error(`Invalid skill.json: ${manifestPath}`);
  return {
    name: manifest.name as string | undefined,
    version: manifest.version as string | undefined,
  };
}

function readLockfile(path: string, options: { force?: boolean }): SkillLockfile {
  if (!existsSync(path)) return { version: skillLockVersion, skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid lockfile root");
    const lockfile = parsed as SkillLockfile;
    if (lockfile.skills !== undefined && (!lockfile.skills || typeof lockfile.skills !== "object" || Array.isArray(lockfile.skills))) {
      throw new Error("invalid skills map");
    }
    lockfile.skills ??= {};
    for (const [name, record] of Object.entries(lockfile.skills)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`invalid skill record: ${name}`);
      record.ownership = resolveSkillOwnership(name, record);
    }
    lockfile.version = Math.max(lockfile.version ?? 0, skillLockVersion);
    return lockfile;
  } catch {
    if (!options.force) throw new Error(`Unable to parse skill lockfile: ${path}`);
    const backup = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    return { version: skillLockVersion, skills: {} };
  }
}

function resolveSkillOwnership(skillName: string, record: SkillLockRecord): SkillOwnership {
  if (record.ownership === "bundled" || record.ownership === "user") return record.ownership;
  if (record.ownership !== undefined) throw new Error(`Invalid skill ownership for ${skillName}`);
  return legacyBundledSkillsAtOwnershipV4.has(skillName) ? "bundled" : "user";
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function nativeSkillDirs(paths: SkillPaths): string[] {
  // Cursor is included as its canonical native projection. See CURSOR_SKILL_DISCOVERY_NOTE.
  return [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir, paths.cursorSkillsDir];
}

function projectNativeSkill(input: { skillName: string; sharedDir: string; nativeDir: string; linkMode: SkillLinkMode; force?: boolean }): void {
  mkdirSync(input.nativeDir, { recursive: true });
  const nativePath = join(input.nativeDir, input.skillName);
  if (pathExists(nativePath)) {
    if (!input.force && !isExpectedNativeEntry(nativePath, input.sharedDir, input.linkMode)) {
      throw new Error(`Native skill path already exists: ${nativePath}`);
    }
    rmSync(nativePath, { recursive: true, force: true });
  }

  if (input.linkMode === "copy") {
    cpSync(input.sharedDir, nativePath, { recursive: true });
    return;
  }
  const target = relative(input.nativeDir, input.sharedDir);
  symlinkSync(target, nativePath, "dir");
}

function isExpectedNativeEntry(nativePath: string, sharedDir: string, linkMode: SkillLinkMode): boolean {
  try {
    const stat = lstatSync(nativePath);
    if (linkMode === "symlink") {
      return stat.isSymbolicLink() && resolve(dirname(nativePath), readlinkSync(nativePath)) === resolve(sharedDir);
    }
    return stat.isDirectory() && hashDirectory(nativePath) === hashDirectory(sharedDir);
  } catch {
    return false;
  }
}

function verifyNativeSkill(input: { nativePath: string; sharedDir: string; linkMode: SkillLinkMode; expectedHash: string }): string | null {
  if (!pathExists(input.nativePath)) return `Native skill entry is missing: ${input.nativePath}`;
  if (!existsSync(join(input.nativePath, "SKILL.md"))) return `Native skill SKILL.md is missing or unreadable: ${input.nativePath}`;
  const stat = lstatSync(input.nativePath);
  if (input.linkMode === "symlink") {
    if (!stat.isSymbolicLink()) return `Native skill entry is not a symlink: ${input.nativePath}`;
    if (resolve(dirname(input.nativePath), readlinkSync(input.nativePath)) !== resolve(input.sharedDir)) return `Native skill symlink target is stale: ${input.nativePath}`;
    return null;
  }
  if (!stat.isDirectory()) return `Native skill entry is not a directory copy: ${input.nativePath}`;
  if (hashDirectory(input.nativePath) !== input.expectedHash) return `Native skill copied directory hash mismatch: ${input.nativePath}`;
  return null;
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function validateLinkMode(linkMode: string): asserts linkMode is SkillLinkMode {
  if (linkMode !== "symlink" && linkMode !== "copy") throw new Error(`Invalid link mode: ${linkMode}`);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
