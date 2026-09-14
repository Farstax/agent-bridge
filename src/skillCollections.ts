/**
 * PURPOSE: Distribute curated Skills while keeping ordinary Skill installation authoritative and Collections as lightweight curation only.
 * INPUTS: A schema-v2 catalogue of canonical pinned Skills plus Collections containing Skill ids.
 * OUTPUTS: Ordinary shared Skills plus minimal Collection/source/reference bookkeeping for safe install, update, migration, and removal.
 * NEIGHBORS: src/skills.ts, src/userSkills.ts, scripts/skill-manager.ts, docs/SKILL-COLLECTIONS.md
 * LOGIC: Validate/stage immutable Skill content before mutation, reuse installSkillGlobal(), fail closed on ownership/hash/projection conflicts, and reference-count Collection/direct installs.
 */

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSharedSkillsHomeDir, hashDirectory, installSkillGlobal, listLocalCatalog, resolveSkillPaths, uninstallSkillGlobal, verifySkillGlobal, type SkillLinkMode } from "./skills.js";

export const SKILL_COLLECTION_SCHEMA_VERSION = 2;
export const SKILL_COLLECTION_STATE_VERSION = 2;

const fetchTimeoutMs = 15_000;
const maxCatalogueBytes = 2 * 1024 * 1024;
const maxTreeBytes = 8 * 1024 * 1024;
const maxSkillBytes = 12 * 1024 * 1024;
const maxSkillFiles = 256;

type Origin = "author-created" | "adapted-upstream" | "vendored-upstream";

export interface SkillContentRef {
  repository: string;
  revision: string;
  path: string;
  sha256: string;
}

export interface SkillProvenance {
  origin: Origin;
  upstreamRepository?: string;
  upstreamRevision?: string;
  upstreamLicense?: string;
  noticePath?: string;
  noticeSha256?: string;
  modifiedFromUpstream: boolean;
  lastReviewed: string;
}

export interface ManagedSkillDefinition {
  id: string;
  description: string;
  content: SkillContentRef;
  provenance: SkillProvenance;
}

export interface SkillCollection {
  id: string;
  name: string;
  description: string;
  skills: string[];
}

export interface SkillCollectionCatalogue {
  schemaVersion: 2;
  catalogueId: string;
  skills: ManagedSkillDefinition[];
  collections: SkillCollection[];
}

export interface SkillCollectionManagerOptions {
  catalogueSource?: string;
  homeDir?: string;
  linkMode?: SkillLinkMode;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface SkillCollectionInstallResult {
  collectionId: string;
  installed: string[];
  retained: string[];
  removed: string[];
}

type InstalledManagedSkill = {
  explicit: boolean;
  collectionRefs: string[];
  content: SkillContentRef;
  provenance: SkillProvenance;
  installedAt: string;
  updatedAt: string;
  noticeLocalPath?: string;
};

type InstalledCollection = {
  catalogueId: string;
  catalogueSource: string;
  skills: string[];
  installedAt: string;
  updatedAt: string;
};

export type SkillCollectionState = {
  version: 2;
  collections: Record<string, InstalledCollection>;
  skills: Record<string, InstalledManagedSkill>;
};

type LegacyState = {
  version: 1;
  packs: Record<string, {
    catalogueId?: unknown;
    catalogueSource?: unknown;
    skills?: unknown;
    installedAt?: unknown;
    updatedAt?: unknown;
  }>;
  skills: Record<string, {
    explicit?: unknown;
    packRefs?: unknown;
    content?: unknown;
    provenance?: unknown;
    installedAt?: unknown;
    updatedAt?: unknown;
    noticeLocalPath?: unknown;
  }>;
};

type Prepared = { skill: ManagedSkillDefinition; repository: string; notice?: string };
type Paths = {
  homeDir: string;
  lockfile: string;
  notices: string;
  legacyLockfile: string;
  legacyRoot: string;
};
type CoreRegistration = { ownership: "bundled" | "user"; linkMode: SkillLinkMode; cursorProjected: boolean; skillFolderHash?: string };

function collectionPaths(homeDir = getSharedSkillsHomeDir()): Paths {
  return {
    homeDir,
    lockfile: join(homeDir, ".agents", ".skill-collection-lock.json"),
    notices: join(homeDir, ".agents", "skill-collections", "notices"),
    legacyLockfile: join(homeDir, ".agents", ".skill-pack-lock.json"),
    legacyRoot: join(homeDir, ".agents", "skill-packs"),
  };
}

export function hashSkillCollectionDirectorySha256(dir: string): string {
  const hash = createHash("sha256");
  for (const file of files(dir)) {
    hash.update(relative(dir, file).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function loadSkillCollectionCatalogue(options: SkillCollectionManagerOptions = {}): Promise<SkillCollectionCatalogue> {
  const source = catalogueSource(options);
  const text = await readSource(source, options.fetchImpl ?? fetch, maxCatalogueBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid Skill Collection catalogue JSON: ${source}`);
  }
  return validateCatalogue(parsed);
}

export async function listAvailableSkillCollections(options: SkillCollectionManagerOptions = {}): Promise<SkillCollection[]> {
  return (await loadSkillCollectionCatalogue(options)).collections.slice().sort((a, b) => a.id.localeCompare(b.id));
}

export async function getAvailableSkillCollection(collectionId: string, options: SkillCollectionManagerOptions = {}): Promise<SkillCollection> {
  id(collectionId, "collection id");
  const collection = (await loadSkillCollectionCatalogue(options)).collections.find((candidate) => candidate.id === collectionId);
  if (!collection) throw new Error(`Unknown Skill Collection: ${collectionId}`);
  return collection;
}

export function getSkillCollectionStatus(options: Pick<SkillCollectionManagerOptions, "homeDir"> = {}): SkillCollectionState {
  return readState(collectionPaths(options.homeDir));
}

export async function installSkillCollection(collectionId: string, options: SkillCollectionManagerOptions = {}): Promise<SkillCollectionInstallResult> {
  const ctx = await context(collectionId, options);
  if (ctx.state.collections[collectionId]) throw new Error(`Skill Collection already installed: ${collectionId}; use collections update`);
  return convergeCollection(ctx, "install");
}

export async function updateSkillCollection(collectionId: string, options: SkillCollectionManagerOptions = {}): Promise<SkillCollectionInstallResult> {
  const ctx = await context(collectionId, options);
  if (!ctx.state.collections[collectionId]) throw new Error(`Skill Collection is not installed: ${collectionId}`);
  return convergeCollection(ctx, "update");
}

export async function installManagedSkill(skillId: string, options: SkillCollectionManagerOptions = {}): Promise<SkillCollectionInstallResult> {
  id(skillId, "skill id");
  const source = catalogueSource(options);
  const catalogue = await loadSkillCollectionCatalogue({ ...options, catalogueSource: source });
  const skill = skillById(catalogue, skillId);
  const paths = collectionPaths(options.homeDir);
  const state = readState(paths);
  preflight([skill], state, paths.homeDir, source, "explicit", undefined);
  const result = await convergeSkills([skill], state, paths, source, options, "explicit", undefined);
  return { collectionId: "explicit", installed: result.installed, retained: result.retained, removed: [] };
}

export function removeManagedSkill(skillId: string, options: Pick<SkillCollectionManagerOptions, "homeDir" | "now"> = {}): SkillCollectionInstallResult {
  id(skillId, "skill id");
  const paths = collectionPaths(options.homeDir);
  const state = readState(paths);
  const entry = state.skills[skillId];
  if (!entry?.explicit) throw new Error(`Skill is not explicitly installed from a managed catalogue: ${skillId}`);
  entry.explicit = false;
  entry.updatedAt = (options.now ?? new Date()).toISOString();
  if (entry.collectionRefs.length) {
    writeState(paths, state);
    return { collectionId: "explicit", installed: [], retained: [skillId], removed: [] };
  }
  uninstallManagedSkill(skillId, paths.homeDir);
  removeNotice(entry.noticeLocalPath, paths.homeDir);
  delete state.skills[skillId];
  writeState(paths, state);
  return { collectionId: "explicit", installed: [], retained: [], removed: [skillId] };
}

export function removeSkillCollection(collectionId: string, options: Pick<SkillCollectionManagerOptions, "homeDir" | "now"> = {}): SkillCollectionInstallResult {
  id(collectionId, "collection id");
  const paths = collectionPaths(options.homeDir);
  const state = readState(paths);
  const collection = state.collections[collectionId];
  if (!collection) throw new Error(`Skill Collection is not installed: ${collectionId}`);

  const retained: string[] = [];
  const removed: string[] = [];
  const now = (options.now ?? new Date()).toISOString();
  for (const skillId of collection.skills) {
    id(skillId, `installed Skill id in collection ${collectionId}`);
    const entry = state.skills[skillId];
    if (!entry) throw new Error(`Skill Collection state is inconsistent: missing Skill ${skillId}`);
    entry.collectionRefs = entry.collectionRefs.filter((ref) => ref !== collectionId);
    entry.updatedAt = now;
    if (entry.explicit || entry.collectionRefs.length) {
      retained.push(skillId);
      continue;
    }
    uninstallManagedSkill(skillId, paths.homeDir);
    removeNotice(entry.noticeLocalPath, paths.homeDir);
    delete state.skills[skillId];
    removed.push(skillId);
  }
  delete state.collections[collectionId];
  writeState(paths, state);
  return { collectionId, installed: [], retained, removed };
}

async function context(collectionId: string, options: SkillCollectionManagerOptions) {
  id(collectionId, "collection id");
  const source = catalogueSource(options);
  const catalogue = await loadSkillCollectionCatalogue({ ...options, catalogueSource: source });
  const collection = catalogue.collections.find((candidate) => candidate.id === collectionId);
  if (!collection) throw new Error(`Unknown Skill Collection: ${collectionId}`);
  const skills = collection.skills.map((skillId) => skillById(catalogue, skillId));
  const paths = collectionPaths(options.homeDir);
  return { catalogue, collection, skills, source, paths, state: readState(paths), options };
}

async function convergeCollection(ctx: Awaited<ReturnType<typeof context>>, mode: "install" | "update"): Promise<SkillCollectionInstallResult> {
  const { catalogue, collection, skills, source, paths, state, options } = ctx;
  const previous = state.collections[collection.id];
  preflight(skills, state, paths.homeDir, source, mode, collection.id);
  const result = await convergeSkills(skills, state, paths, source, options, mode, collection.id);
  const now = (options.now ?? new Date()).toISOString();

  if (mode === "update" && previous) {
    for (const skillId of previous.skills) {
      if (collection.skills.includes(skillId)) continue;
      const record = state.skills[skillId];
      if (!record) throw new Error(`Skill Collection state is inconsistent: missing Skill ${skillId}`);
      record.collectionRefs = record.collectionRefs.filter((ref) => ref !== collection.id);
      record.updatedAt = now;
      if (!record.explicit && !record.collectionRefs.length) {
        uninstallManagedSkill(skillId, paths.homeDir);
        removeNotice(record.noticeLocalPath, paths.homeDir);
        delete state.skills[skillId];
        result.removed.push(skillId);
      }
    }
  }

  state.collections[collection.id] = {
    catalogueId: catalogue.catalogueId,
    catalogueSource: source,
    skills: collection.skills.slice().sort(),
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  };
  writeState(paths, state);
  return { collectionId: collection.id, ...result };
}

async function convergeSkills(
  skills: ManagedSkillDefinition[],
  state: SkillCollectionState,
  paths: Paths,
  source: string,
  options: SkillCollectionManagerOptions,
  mode: "install" | "update" | "explicit",
  collectionId: string | undefined,
): Promise<{ installed: string[]; retained: string[]; removed: string[] }> {
  const linkMode = options.linkMode ?? "symlink";
  if (linkMode !== "symlink" && linkMode !== "copy") throw new Error(`Invalid link mode: ${linkMode}`);

  const staging = mkdtempSync(join(tmpdir(), "agent-bridge-skill-collection-"));
  const repoRoot = join(staging, "repo");
  const prepared: Prepared[] = [];
  try {
    for (const skill of skills) prepared.push(await prepare(skill, source, repoRoot, options.fetchImpl ?? fetch));
    const staged = new Set(listLocalCatalog(repoRoot).map((entry) => entry.name));
    for (const skill of skills) if (!staged.has(skill.id)) throw new Error(`Prepared Skill is invalid: ${skill.id}`);

    const now = (options.now ?? new Date()).toISOString();
    const installed: string[] = [];
    const retained: string[] = [];
    for (const item of prepared) {
      const previous = state.skills[item.skill.id];
      const registration = coreRegistration(item.skill.id, paths.homeDir);
      const refs = new Set(previous?.collectionRefs ?? []);
      if (collectionId) refs.add(collectionId);
      const explicit = mode === "explicit" || Boolean(previous?.explicit);
      commitNotice(item, paths);

      // Persist intended managed provenance/reference state before mutating the
      // ordinary Skill. A retry can then safely recognise an interrupted install.
      state.skills[item.skill.id] = {
        explicit,
        collectionRefs: [...refs].sort(),
        content: { ...item.skill.content, repository: item.repository },
        provenance: item.skill.provenance,
        installedAt: previous?.installedAt ?? now,
        updatedAt: now,
        noticeLocalPath: item.notice
          ? relative(paths.homeDir, join(paths.notices, item.skill.id, basename(item.notice))).split("\\").join("/")
          : previous?.noticeLocalPath,
      };
      writeState(paths, state);

      const canonical = join(resolveSkillPaths(paths.homeDir).agentsSkillsDir, item.skill.id);
      const unchanged = Boolean(registration)
        && previous
        && sameSkillContract(previous, item.skill, item.repository, source)
        && existsSync(canonical)
        && hashSkillCollectionDirectorySha256(canonical) === item.skill.content.sha256
        && verifySkillGlobal(item.skill.id, { homeDir: paths.homeDir }).ok;
      if (registration && unchanged) {
        retained.push(item.skill.id);
      } else {
        installSkillGlobal(item.skill.id, {
          repoRoot,
          homeDir: paths.homeDir,
          force: Boolean(registration),
          linkMode,
          ownership: "user",
          now: options.now,
          projectCursor: Boolean(registration?.cursorProjected),
        });
        installed.push(item.skill.id);
      }
    }
    return { installed, retained, removed: [] };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function preflight(
  skills: ManagedSkillDefinition[],
  state: SkillCollectionState,
  homeDir: string,
  source: string,
  mode: "install" | "update" | "explicit",
  collectionId: string | undefined,
): void {
  const paths = resolveSkillPaths(homeDir);
  for (const skill of skills) {
    const prior = state.skills[skill.id];
    const registration = coreRegistration(skill.id, homeDir);
    const canonical = join(paths.agentsSkillsDir, skill.id);
    const repository = contentRepository(skill.content.repository, source);

    if (!registration && existsSync(canonical)) throw new Error(`Refusing managed install over unregistered shared Skill: ${skill.id}`);
    if (registration?.ownership === "bundled") throw new Error(`Refusing managed install over bundled-owned Skill: ${skill.id}`);
    if (registration?.ownership === "user" && !prior) throw new Error(`Refusing managed install over user-owned Skill: ${skill.id}`);
    if (registration && prior) assertManagedProjectionSafe(skill.id, paths, registration);
    if (!registration && prior && !sameSkillContract(prior, skill, repository, source)) {
      throw new Error(`Skill Collection state is inconsistent for missing managed Skill: ${skill.id}`);
    }
    if (!registration) {
      for (const dir of [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir]) {
        if (pathExists(join(dir, skill.id))) throw new Error(`Refusing managed install over unmanaged native Skill path: ${join(dir, skill.id)}`);
      }
    }
    if (!prior || sameSkillContract(prior, skill, repository, source)) continue;

    if (mode === "install") throw new Error(`Skill Collection state is inconsistent for interrupted install of ${skill.id}`);
    if (mode === "explicit") {
      if (prior.collectionRefs.length) throw new Error(`Cannot change Skill ${skill.id} through direct install while referenced by Collections: ${prior.collectionRefs.join(", ")}`);
      continue;
    }
    const others = prior.collectionRefs.filter((ref) => ref !== collectionId);
    if (others.length) throw new Error(`Cannot change shared Skill ${skill.id}; still referenced by Collections: ${others.join(", ")}`);
    if (prior.explicit) throw new Error(`Cannot change explicitly installed Skill ${skill.id} during Collection convergence`);
  }
}

async function prepare(skill: ManagedSkillDefinition, catalogueSourceValue: string, repoRoot: string, fetchImpl: typeof fetch): Promise<Prepared> {
  const repository = contentRepository(skill.content.repository, catalogueSourceValue);
  const target = join(repoRoot, "skills", skill.id);
  mkdirSync(dirname(target), { recursive: true });

  if (githubRepo(repository)) {
    if (!/^[0-9a-f]{40}$/i.test(skill.content.revision)) throw new Error(`GitHub Skill content revision must be an exact 40-character commit SHA: ${skill.id}`);
    await githubDirectory(repository, skill.content.revision, skill.content.path, target, fetchImpl);
  } else {
    const from = safeJoin(localRepo(repository), skill.content.path, `Skill content path for ${skill.id}`);
    if (!existsSync(from) || !lstatSync(from).isDirectory()) throw new Error(`Skill content directory does not exist: ${from}`);
    cpSync(from, target, { recursive: true });
  }

  const actual = hashSkillCollectionDirectorySha256(target);
  if (actual !== skill.content.sha256) throw new Error(`Skill content checksum mismatch for ${skill.id}: expected ${skill.content.sha256}, got ${actual}`);

  let notice: string | undefined;
  if (skill.provenance.noticePath) {
    notice = join(dirname(repoRoot), "notices", skill.id, basename(skill.provenance.noticePath));
    mkdirSync(dirname(notice), { recursive: true });
    if (githubRepo(repository)) {
      writeFileSync(notice, await githubFile(repository, skill.content.revision, skill.provenance.noticePath, fetchImpl));
    } else {
      const from = safeJoin(localRepo(repository), skill.provenance.noticePath, `notice path for ${skill.id}`);
      if (!existsSync(from) || !lstatSync(from).isFile()) throw new Error(`Provenance notice does not exist: ${from}`);
      cpSync(from, notice);
    }
    if (fileSha256(notice) !== skill.provenance.noticeSha256) throw new Error(`Provenance notice checksum mismatch for ${skill.id}`);
  }
  return { skill, repository, notice };
}

function commitNotice(item: Prepared, paths: Paths): void {
  if (!item.notice) return;
  const target = join(paths.notices, item.skill.id, basename(item.notice));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(item.notice, target);
}

async function githubDirectory(repository: string, revision: string, sourcePath: string, target: string, fetchImpl: typeof fetch): Promise<void> {
  const { owner, repo } = githubParts(repository);
  const tree = JSON.parse(await fetchText(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${revision}?recursive=1`, fetchImpl, maxTreeBytes)) as {
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; mode?: string }>;
  };
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error(`Invalid or truncated GitHub tree for ${repository}@${revision}`);
  const prefix = relPath(sourcePath, "Skill content path");
  const slash = `${prefix}/`;
  const entries = tree.tree.filter((entry) => entry.type === "blob" && typeof entry.path === "string" && entry.path.startsWith(slash));
  if (!entries.length) throw new Error(`No files found at ${repository}@${revision}:${prefix}`);
  if (entries.length > maxSkillFiles) throw new Error(`Skill content exceeds ${maxSkillFiles} files`);

  let total = 0;
  for (const entry of entries) {
    if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error(`Unsupported GitHub Skill file mode ${String(entry.mode)}`);
    const bytes = await githubFile(repository, revision, entry.path!, fetchImpl);
    total += bytes.length;
    if (total > maxSkillBytes) throw new Error(`Skill content exceeds ${maxSkillBytes} bytes`);
    const dest = safeJoin(target, entry.path!.slice(slash.length), "GitHub Skill file path");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    if (entry.mode === "100755") chmodSync(dest, 0o755);
  }
}

async function githubFile(repository: string, revision: string, path: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const { owner, repo } = githubParts(repository);
  const encoded = relPath(path, "GitHub file path").split("/").map(encodeURIComponent).join("/");
  return fetchBytes(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${revision}/${encoded}`, fetchImpl, maxSkillBytes);
}

function validateCatalogue(raw: unknown): SkillCollectionCatalogue {
  record(raw, "Skill Collection catalogue");
  only(raw, ["schemaVersion", "catalogueId", "skills", "collections"], "Skill Collection catalogue");
  if (raw.schemaVersion !== SKILL_COLLECTION_SCHEMA_VERSION) throw new Error(`Unsupported Skill Collection catalogue schemaVersion: ${String(raw.schemaVersion)}`);
  if (!Array.isArray(raw.skills)) throw new Error("Skill Collection catalogue skills must be an array");
  if (!Array.isArray(raw.collections)) throw new Error("Skill Collection catalogue collections must be an array");
  const skills = raw.skills.map((item, index) => validateSkill(item, `skills[${index}]`));
  const collections = raw.collections.map((item, index) => validateCollection(item, `collections[${index}]`));
  unique(skills.map((skill) => skill.id), "Skill id");
  unique(collections.map((collection) => collection.id), "Collection id");
  const known = new Set(skills.map((skill) => skill.id));
  for (const collection of collections) {
    for (const skillId of collection.skills) if (!known.has(skillId)) throw new Error(`Collection ${collection.id} references unknown Skill: ${skillId}`);
  }
  return { schemaVersion: 2, catalogueId: text(raw.catalogueId, "catalogueId", 128), skills, collections };
}

function validateSkill(raw: unknown, label: string): ManagedSkillDefinition {
  record(raw, label);
  only(raw, ["id", "description", "content", "provenance"], label);
  return {
    id: id(raw.id, `${label}.id`),
    description: text(raw.description, `${label}.description`, 1024),
    content: content(raw.content, `${label}.content`),
    provenance: provenance(raw.provenance, `${label}.provenance`),
  };
}

function validateCollection(raw: unknown, label: string): SkillCollection {
  record(raw, label);
  only(raw, ["id", "name", "description", "skills"], label);
  if (!Array.isArray(raw.skills)) throw new Error(`${label}.skills must be an array`);
  const skills = raw.skills.map((value, index) => id(value, `${label}.skills[${index}]`));
  unique(skills, `Skill reference in ${label}`);
  return {
    id: id(raw.id, `${label}.id`),
    name: text(raw.name, `${label}.name`, 160),
    description: text(raw.description, `${label}.description`, 1024),
    skills,
  };
}

function content(raw: unknown, label: string): SkillContentRef {
  record(raw, label);
  only(raw, ["repository", "revision", "path", "sha256"], label);
  return {
    repository: text(raw.repository, `${label}.repository`, 2048),
    revision: text(raw.revision, `${label}.revision`, 160),
    path: relPath(text(raw.path, `${label}.path`, 1024), `${label}.path`),
    sha256: sha(raw.sha256, `${label}.sha256`),
  };
}

function provenance(raw: unknown, label: string): SkillProvenance {
  record(raw, label);
  only(raw, ["origin", "upstreamRepository", "upstreamRevision", "upstreamLicense", "noticePath", "noticeSha256", "modifiedFromUpstream", "lastReviewed"], label);
  const origin = raw.origin;
  if (origin !== "author-created" && origin !== "adapted-upstream" && origin !== "vendored-upstream") throw new Error(`${label}.origin is invalid`);
  if (typeof raw.modifiedFromUpstream !== "boolean") throw new Error(`${label}.modifiedFromUpstream must be boolean`);
  const base: SkillProvenance = { origin, modifiedFromUpstream: raw.modifiedFromUpstream, lastReviewed: isoDate(raw.lastReviewed, `${label}.lastReviewed`) };
  if (origin === "author-created") {
    if (raw.modifiedFromUpstream || [raw.upstreamRepository, raw.upstreamRevision, raw.upstreamLicense, raw.noticePath, raw.noticeSha256].some((value) => value !== undefined)) {
      throw new Error(`${label} has invalid upstream provenance for author-created content`);
    }
    return base;
  }
  const upstreamRepository = https(raw.upstreamRepository, `${label}.upstreamRepository`);
  const upstreamRevision = text(raw.upstreamRevision, `${label}.upstreamRevision`, 160);
  if (/^https:\/\/github\.com\//i.test(upstreamRepository) && !/^[0-9a-f]{40}$/i.test(upstreamRevision)) {
    throw new Error(`${label}.upstreamRevision must be an exact 40-character commit SHA for GitHub upstreams`);
  }
  return {
    ...base,
    upstreamRepository,
    upstreamRevision,
    upstreamLicense: spdx(raw.upstreamLicense, `${label}.upstreamLicense`),
    noticePath: relPath(text(raw.noticePath, `${label}.noticePath`, 1024), `${label}.noticePath`),
    noticeSha256: sha(raw.noticeSha256, `${label}.noticeSha256`),
  };
}

function skillById(catalogue: SkillCollectionCatalogue, skillId: string): ManagedSkillDefinition {
  const skill = catalogue.skills.find((candidate) => candidate.id === skillId);
  if (!skill) throw new Error(`Unknown managed Skill: ${skillId}`);
  return skill;
}

function coreRegistration(skillId: string, homeDir: string): CoreRegistration | undefined {
  const path = resolveSkillPaths(homeDir).lockfilePath;
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new Error(`Unable to parse skill lockfile: ${path}`); }
  if (!isRecord(raw) || !isRecord(raw.skills)) throw new Error(`Unable to parse skill lockfile: ${path}`);
  const value = raw.skills[skillId];
  if (value === undefined) return undefined;
  if (!isRecord(value) || (value.ownership !== "bundled" && value.ownership !== "user")) throw new Error(`Invalid skill registration for ${skillId}`);
  if (value.linkMode !== undefined && value.linkMode !== "symlink" && value.linkMode !== "copy") throw new Error(`Invalid skill registration link mode for ${skillId}`);
  if (value.skillFolderHash !== undefined && (typeof value.skillFolderHash !== "string" || !/^[0-9a-f]{40}$/i.test(value.skillFolderHash))) throw new Error(`Invalid skill registration hash for ${skillId}`);
  return {
    ownership: value.ownership,
    linkMode: value.linkMode === "copy" ? "copy" : "symlink",
    cursorProjected: value.cursorProjected === true,
    skillFolderHash: typeof value.skillFolderHash === "string" ? value.skillFolderHash : undefined,
  };
}

function assertManagedProjectionSafe(skillId: string, paths: ReturnType<typeof resolveSkillPaths>, registration: CoreRegistration): void {
  const shared = join(paths.agentsSkillsDir, skillId);
  const dirs = [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir, ...(registration.cursorProjected ? [paths.cursorSkillsDir] : [])];
  for (const dir of dirs) {
    const native = join(dir, skillId);
    if (!pathExists(native)) continue;
    let expected = false;
    try {
      const stat = lstatSync(native);
      expected = registration.linkMode === "symlink"
        ? stat.isSymbolicLink() && resolve(dirname(native), readlinkSync(native)) === resolve(shared)
        : Boolean(registration.skillFolderHash) && stat.isDirectory() && hashDirectory(native) === registration.skillFolderHash;
    } catch {}
    if (!expected) throw new Error(`Refusing Collection convergence over unmanaged native Skill path: ${native}`);
  }
}

function uninstallManagedSkill(skillId: string, homeDir: string): void {
  id(skillId, "managed Skill id");
  const registration = coreRegistration(skillId, homeDir);
  if (!registration) return;
  if (registration.ownership !== "user") throw new Error(`Refusing to remove non-managed Skill ${skillId}`);
  assertManagedProjectionSafe(skillId, resolveSkillPaths(homeDir), registration);
  uninstallSkillGlobal(skillId, { homeDir, expectedOwnership: "user" });
}

function readState(paths: Paths): SkillCollectionState {
  if (existsSync(paths.lockfile)) {
    const state = parseCurrentState(paths.lockfile);
    cleanupLegacy(paths);
    return state;
  }
  if (!existsSync(paths.legacyLockfile)) return { version: 2, collections: {}, skills: {} };
  return migrateLegacyState(paths);
}

function parseCurrentState(path: string): SkillCollectionState {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new Error(`Unable to parse Skill Collection lockfile: ${path}`); }
  if (!isRecord(raw) || raw.version !== 2 || !isRecord(raw.collections) || !isRecord(raw.skills)) throw new Error(`Invalid Skill Collection lockfile: ${path}`);
  return raw as SkillCollectionState;
}

function migrateLegacyState(paths: Paths): SkillCollectionState {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(paths.legacyLockfile, "utf8")) as unknown; } catch { throw new Error(`Unable to parse legacy Skill Pack lockfile: ${paths.legacyLockfile}`); }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.packs) || !isRecord(raw.skills)) throw new Error(`Invalid legacy Skill Pack lockfile: ${paths.legacyLockfile}`);
  const legacy = raw as unknown as LegacyState;
  const state: SkillCollectionState = { version: 2, collections: {}, skills: {} };

  for (const [collectionId, value] of Object.entries(legacy.packs)) {
    id(collectionId, "legacy Pack id");
    if (!isRecord(value)) throw new Error(`Invalid legacy Skill Pack state for ${collectionId}`);
    if (typeof value.catalogueId !== "string" || typeof value.catalogueSource !== "string" || !Array.isArray(value.skills) || typeof value.installedAt !== "string" || typeof value.updatedAt !== "string") {
      throw new Error(`Invalid legacy Skill Pack state for ${collectionId}`);
    }
    const skills = value.skills.map((skillId, index) => id(skillId, `legacy Pack ${collectionId} skills[${index}]`));
    state.collections[collectionId] = {
      catalogueId: value.catalogueId,
      catalogueSource: value.catalogueSource,
      skills: skills.slice().sort(),
      installedAt: value.installedAt,
      updatedAt: value.updatedAt,
    };
  }

  for (const [skillId, value] of Object.entries(legacy.skills)) {
    id(skillId, "legacy managed Skill id");
    if (!isRecord(value) || typeof value.explicit !== "boolean" || !Array.isArray(value.packRefs) || typeof value.installedAt !== "string" || typeof value.updatedAt !== "string") {
      throw new Error(`Invalid legacy Skill Pack Skill state for ${skillId}`);
    }
    const parsedContent = content(value.content, `legacy Skill ${skillId}.content`);
    const parsedProvenance = provenance(value.provenance, `legacy Skill ${skillId}.provenance`);
    const collectionRefs = value.packRefs.map((ref, index) => id(ref, `legacy Skill ${skillId}.packRefs[${index}]`)).sort();
    let noticeLocalPath = typeof value.noticeLocalPath === "string" ? value.noticeLocalPath : undefined;
    if (noticeLocalPath) noticeLocalPath = migrateLegacyNotice(paths, skillId, noticeLocalPath);
    state.skills[skillId] = {
      explicit: value.explicit,
      collectionRefs,
      content: parsedContent,
      provenance: parsedProvenance,
      installedAt: value.installedAt,
      updatedAt: value.updatedAt,
      noticeLocalPath,
    };
  }

  writeState(paths, state);
  cleanupLegacy(paths);
  return state;
}

function migrateLegacyNotice(paths: Paths, skillId: string, relativePath: string): string {
  const oldPath = safeJoin(paths.homeDir, relativePath, "legacy installed notice path");
  if (!existsSync(oldPath)) return relativePath;
  const target = join(paths.notices, skillId, basename(oldPath));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(oldPath, target);
  return relative(paths.homeDir, target).split("\\").join("/");
}

function cleanupLegacy(paths: Paths): void {
  rmSync(paths.legacyLockfile, { force: true });
  rmSync(join(paths.legacyRoot, "manifests"), { recursive: true, force: true });
  rmSync(join(paths.legacyRoot, "notices"), { recursive: true, force: true });
  try {
    if (existsSync(paths.legacyRoot) && !readdirSync(paths.legacyRoot).length) rmSync(paths.legacyRoot, { recursive: true, force: true });
  } catch {}
}

function writeState(paths: Paths, state: SkillCollectionState): void {
  state.version = 2;
  atomicJson(paths.lockfile, state);
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function removeNotice(relativePath: string | undefined, homeDir: string): void {
  if (!relativePath) return;
  const path = safeJoin(homeDir, relativePath, "installed notice path");
  rmSync(path, { force: true });
  try { if (!readdirSync(dirname(path)).length) rmSync(dirname(path), { recursive: true, force: true }); } catch {}
}

function catalogueSource(options: SkillCollectionManagerOptions): string {
  const source = options.catalogueSource ?? process.env.AGENT_BRIDGE_SKILL_COLLECTION_CATALOGUE;
  if (!source) throw new Error("No Skill Collection catalogue source configured; set AGENT_BRIDGE_SKILL_COLLECTION_CATALOGUE or pass catalogueSource explicitly.");
  return source;
}

async function readSource(source: string, fetchImpl: typeof fetch, max: number): Promise<string> {
  const local = localPath(source);
  if (local) {
    const bytes = readFileSync(local);
    if (bytes.length > max) throw new Error(`Skill Collection catalogue exceeds ${max} bytes`);
    return bytes.toString("utf8");
  }
  if (!source.startsWith("https://")) throw new Error(`Skill Collection catalogue source must be a local path, file:// URL, or HTTPS URL: ${source}`);
  const allowedRepo = process.env.AGENT_BRIDGE_SKILL_COLLECTION_ALLOWED_REPO?.trim();
  if (!allowedRepo) throw new Error(`Remote Skill Collection catalogues require AGENT_BRIDGE_SKILL_COLLECTION_ALLOWED_REPO to be configured with an "owner/repo" allowlist: ${source}`);
  const url = new URL(source);
  if (url.hostname !== "raw.githubusercontent.com" || !url.pathname.startsWith(`/${allowedRepo}/`)) {
    throw new Error(`Remote Skill Collection catalogues are restricted to the configured ${allowedRepo} repository: ${source}`);
  }
  return fetchText(source, fetchImpl, max);
}

async function fetchText(url: string, fetchImpl: typeof fetch, max: number): Promise<string> {
  return (await fetchBytes(url, fetchImpl, max)).toString("utf8");
}

async function fetchBytes(url: string, fetchImpl: typeof fetch, max: number): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { "user-agent": "agent-bridge-skill-collection-manager" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > max) throw new Error(`Response exceeds ${max} bytes: ${url}`);
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

function contentRepository(repository: string, source: string): string {
  if (githubRepo(repository)) return repository.replace(/\.git$/, "");
  const catalogue = localPath(source);
  if (repository.startsWith("file://") || isAbsolute(repository)) {
    if (!catalogue) throw new Error(`Local Skill content repository requires a local catalogue: ${repository}`);
    return repository;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(repository)) throw new Error(`Unsupported Skill content repository: ${repository}`);
  if (!catalogue) throw new Error(`Relative Skill content repository requires a local catalogue: ${repository}`);
  return resolve(dirname(catalogue), repository);
}

function localPath(source: string): string | null {
  if (source.startsWith("file://")) return fileURLToPath(source);
  if (isAbsolute(source) || !/^[a-z][a-z0-9+.-]*:/i.test(source)) return resolve(source);
  return null;
}

function localRepo(repository: string): string {
  if (repository.startsWith("file://")) return fileURLToPath(repository);
  if (isAbsolute(repository)) return repository;
  throw new Error(`Skill content repository is not local: ${repository}`);
}

function githubRepo(repository: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/i.test(repository);
}

function githubParts(repository: string): { owner: string; repo: string } {
  const match = repository.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`Unsupported GitHub repository URL: ${repository}`);
  return { owner: match[1], repo: match[2] };
}

function sameContent(installed: SkillContentRef, candidate: SkillContentRef, resolvedRepository: string, source: string): boolean {
  return contentRepository(installed.repository, source) === resolvedRepository
    && installed.revision === candidate.revision
    && installed.path === candidate.path
    && installed.sha256 === candidate.sha256;
}

function sameSkillContract(installed: InstalledManagedSkill, candidate: ManagedSkillDefinition, resolvedRepository: string, source: string): boolean {
  if (!sameContent(installed.content, candidate.content, resolvedRepository, source)) return false;
  return JSON.stringify(stable(installed.provenance)) === JSON.stringify(stable(candidate.provenance));
}

function files(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...files(full));
    else if (entry.isFile()) result.push(full);
    else throw new Error(`Unsupported managed Skill filesystem entry: ${full}`);
  }
  return result;
}

function fileSha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function safeJoin(root: string, value: string, label: string): string {
  const normalized = relPath(value, label);
  const target = resolve(root, normalized);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes its repository root`);
  return target;
}
function relPath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "..")) throw new Error(`${label} must be a safe relative path`);
  return normalized;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string <= ${max} characters`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new Error(`${label} must be lowercase kebab-case`);
  return result;
}
function sha(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[0-9a-f]{64}$/i.test(result)) throw new Error(`${label} must be a 64-character SHA-256`);
  return result.toLowerCase();
}
function spdx(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(result)) throw new Error(`${label} must be an SPDX-style licence id`);
  return result;
}
function https(value: unknown, label: string): string {
  const result = text(value, label, 2048);
  let url: URL;
  try { url = new URL(result); } catch { throw new Error(`${label} must be a valid HTTPS URL`); }
  if (url.protocol !== "https:") throw new Error(`${label} must be a valid HTTPS URL`);
  return result;
}
function isoDate(value: unknown, label: string): string {
  const result = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) throw new Error(`${label} must be YYYY-MM-DD`);
  return result;
}
function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function only(value: Record<string, unknown>, allowed: string[], label: string): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !set.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
}
function unique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
