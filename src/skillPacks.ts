/**
 * PURPOSE: Manage optional curated Skill Packs while keeping ordinary Skills and provider-native projection authoritative.
 * INPUTS: A versioned curated catalogue, pinned Skill sources, and explicit pack-management operations.
 * OUTPUTS: Ordinary shared Skills plus durable pack references, provenance, dependency and capability metadata.
 * NEIGHBORS: src/skills.ts, src/userSkills.ts, scripts/skill-manager.ts, docs/SKILL-PACKS.md
 * LOGIC: Validate and stage all content before mutation, reuse installSkillGlobal(), fail closed on ownership/version/hash conflicts, and reference-count overlaps.
 */

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSharedSkillsHomeDir, hashDirectory, installSkillGlobal, listLocalCatalog, resolveSkillPaths, uninstallSkillGlobal, verifySkillGlobal, type SkillLinkMode } from "./skills.js";

export const SKILL_PACK_SCHEMA_VERSION = 1;
export const SKILL_PACK_API_VERSION = 1;
export const DEFAULT_SKILL_PACK_CATALOGUE = "https://raw.githubusercontent.com/Farstax/agent-bridge-skills/main/catalogue.json";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(moduleDir, "..");
const fetchTimeoutMs = 15_000;
const maxCatalogueBytes = 2 * 1024 * 1024;
const maxTreeBytes = 8 * 1024 * 1024;
const maxSkillBytes = 12 * 1024 * 1024;
const maxSkillFiles = 256;

type Origin = "farstax-authored" | "adapted-upstream" | "vendored-upstream";
export type SkillPackEffect = "local-read" | "external-read" | "draft-write" | "external-write" | "spend-mutation";

export interface NamedRequirement { name: string; purpose: string }
export interface ServiceRequirement extends NamedRequirement { url?: string; authorization?: string }
export interface SkillPackDependencies {
  requiredLocal: NamedRequirement[];
  optionalLocal: NamedRequirement[];
  externalServices: ServiceRequirement[];
  hostedMcps: ServiceRequirement[];
  requiredSecrets: NamedRequirement[];
}
export interface SkillPackCapabilities { effects: SkillPackEffect[]; approval: string }
export interface SkillContentRef { repository: string; revision: string; path: string; sha256: string }
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
export interface SkillPackSkill {
  id: string;
  description: string;
  content: SkillContentRef;
  provenance: SkillProvenance;
  supportedHosts: string[];
  dependencies: SkillPackDependencies;
  capabilities: SkillPackCapabilities;
  tests: string[];
}
export interface SkillPackManifest {
  id: string;
  displayName: string;
  description: string;
  version: string;
  maintainer: string;
  license: string;
  categories: string[];
  capabilityTags: string[];
  attribution: string[];
  compatibility: { apiVersion: number; minAgentBridgeVersion?: string; maxAgentBridgeVersion?: string; supportedHosts: string[] };
  dependencies: SkillPackDependencies;
  capabilities: SkillPackCapabilities;
  tests: string[];
  skills: SkillPackSkill[];
}
export interface SkillPackCatalogue { schemaVersion: number; catalogueId: string; catalogueVersion: string; packs: SkillPackManifest[] }
export interface SkillPackManagerOptions {
  catalogueSource?: string;
  homeDir?: string;
  repoRoot?: string;
  linkMode?: SkillLinkMode;
  now?: Date;
  agentBridgeVersion?: string;
  requestedPackVersion?: string;
  fetchImpl?: typeof fetch;
}
export interface SkillPackInstallResult { packId: string; version: string; installed: string[]; retained: string[]; removed: string[] }

type InstalledSkill = {
  explicit: boolean;
  packRefs: string[];
  description: string;
  content: SkillContentRef;
  provenance: SkillProvenance;
  supportedHosts: string[];
  dependencies: SkillPackDependencies;
  capabilities: SkillPackCapabilities;
  tests: string[];
  installedAt: string;
  updatedAt: string;
  noticeLocalPath?: string;
};
type InstalledPack = {
  version: string;
  manifestSha256: string;
  catalogueId: string;
  catalogueVersion: string;
  catalogueSource: string;
  skills: string[];
  manifest: SkillPackManifest;
  installedAt: string;
  updatedAt: string;
};
type PackState = {
  version: number;
  packs: Record<string, InstalledPack>;
  skills: Record<string, InstalledSkill>;
};
type Prepared = { skill: SkillPackSkill; repository: string; notice?: string };
type Paths = { homeDir: string; lockfile: string; manifests: string; notices: string };
type CoreRegistration = { ownership: "bundled" | "user"; linkMode: SkillLinkMode; cursorProjected: boolean; skillFolderHash?: string };

function packPaths(homeDir = getSharedSkillsHomeDir()): Paths {
  const root = join(homeDir, ".agents", "skill-packs");
  return { homeDir, lockfile: join(homeDir, ".agents", ".skill-pack-lock.json"), manifests: join(root, "manifests"), notices: join(root, "notices") };
}

export function hashSkillPackDirectorySha256(dir: string): string {
  const hash = createHash("sha256");
  for (const file of files(dir)) {
    hash.update(relative(dir, file).split("\\").join("/")); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0");
  }
  return hash.digest("hex");
}

export async function loadSkillPackCatalogue(options: SkillPackManagerOptions = {}): Promise<SkillPackCatalogue> {
  const source = options.catalogueSource ?? process.env.AGENT_BRIDGE_SKILL_PACK_CATALOGUE ?? DEFAULT_SKILL_PACK_CATALOGUE;
  const text = await readSource(source, options.fetchImpl ?? fetch, maxCatalogueBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error(`Invalid Skill Pack catalogue JSON: ${source}`); }
  return validateCatalogue(parsed);
}

export async function listAvailableSkillPacks(options: SkillPackManagerOptions = {}): Promise<SkillPackManifest[]> {
  return (await loadSkillPackCatalogue(options)).packs.slice().sort((a, b) => a.id.localeCompare(b.id) || compareVersion(b.version, a.version));
}

export async function getAvailableSkillPack(packId: string, options: SkillPackManagerOptions = {}): Promise<SkillPackManifest> {
  id(packId, "pack id");
  const pack = selectPack(await loadSkillPackCatalogue(options), packId, options.requestedPackVersion);
  compatible(pack, bridgeVersion(options));
  return pack;
}

export function getSkillPackStatus(options: Pick<SkillPackManagerOptions, "homeDir"> = {}): PackState {
  return readState(packPaths(options.homeDir).lockfile);
}

export async function installSkillPack(packId: string, options: SkillPackManagerOptions = {}): Promise<SkillPackInstallResult> {
  const ctx = await context(packId, options);
  if (ctx.state.packs[packId]) throw new Error(`Skill Pack already installed: ${packId}; use packs update`);
  return converge(ctx, ctx.pack.skills, "install");
}

export async function updateSkillPack(packId: string, options: SkillPackManagerOptions = {}): Promise<SkillPackInstallResult> {
  const ctx = await context(packId, options);
  if (!ctx.state.packs[packId]) throw new Error(`Skill Pack is not installed: ${packId}`);
  return converge(ctx, ctx.pack.skills, "update");
}

export async function installSkillFromPack(packId: string, skillId: string, options: SkillPackManagerOptions = {}): Promise<SkillPackInstallResult> {
  id(skillId, "skill id");
  const ctx = await context(packId, options);
  const skill = ctx.pack.skills.find((candidate) => candidate.id === skillId);
  if (!skill) throw new Error(`Skill ${skillId} is not in pack ${packId}`);
  return converge(ctx, [skill], "explicit");
}

export function removeSkillPack(packId: string, options: Pick<SkillPackManagerOptions, "homeDir" | "now"> = {}): SkillPackInstallResult {
  id(packId, "pack id");
  const paths = packPaths(options.homeDir); const state = readState(paths.lockfile); const pack = state.packs[packId];
  if (!pack) throw new Error(`Skill Pack is not installed: ${packId}`);
  const retained: string[] = []; const removed: string[] = []; const now = (options.now ?? new Date()).toISOString();
  for (const skillId of pack.skills) {
    id(skillId, `installed Skill id in pack ${packId}`);
    const entry = state.skills[skillId]; if (!entry) throw new Error(`Skill Pack state is inconsistent: missing skill ${skillId}`);
    entry.packRefs = entry.packRefs.filter((ref) => ref !== packId); entry.updatedAt = now;
    if (entry.explicit || entry.packRefs.length) { retained.push(skillId); continue; }
    uninstallPackSkill(skillId, paths.homeDir); removeNotice(entry.noticeLocalPath, paths.homeDir); delete state.skills[skillId]; removed.push(skillId);
  }
  delete state.packs[packId]; rmSync(join(paths.manifests, `${packId}.json`), { force: true }); writeState(paths.lockfile, state);
  return { packId, version: pack.version, installed: [], retained, removed };
}

export function removeExplicitSkillPackSkill(skillId: string, options: Pick<SkillPackManagerOptions, "homeDir" | "now"> = {}): SkillPackInstallResult {
  id(skillId, "skill id"); const paths = packPaths(options.homeDir); const state = readState(paths.lockfile); const entry = state.skills[skillId];
  if (!entry?.explicit) throw new Error(`Skill is not explicitly installed from a pack: ${skillId}`);
  entry.explicit = false; entry.updatedAt = (options.now ?? new Date()).toISOString();
  if (entry.packRefs.length) { writeState(paths.lockfile, state); return { packId: "explicit", version: "n/a", installed: [], retained: [skillId], removed: [] }; }
  uninstallPackSkill(skillId, paths.homeDir); removeNotice(entry.noticeLocalPath, paths.homeDir); delete state.skills[skillId]; writeState(paths.lockfile, state);
  return { packId: "explicit", version: "n/a", installed: [], retained: [], removed: [skillId] };
}

async function context(packId: string, options: SkillPackManagerOptions) {
  id(packId, "pack id"); const source = options.catalogueSource ?? process.env.AGENT_BRIDGE_SKILL_PACK_CATALOGUE ?? DEFAULT_SKILL_PACK_CATALOGUE;
  const catalogue = await loadSkillPackCatalogue({ ...options, catalogueSource: source }); const pack = selectPack(catalogue, packId, options.requestedPackVersion);
  compatible(pack, bridgeVersion(options)); const paths = packPaths(options.homeDir); return { catalogue, source, pack, paths, state: readState(paths.lockfile), options };
}

async function converge(ctx: Awaited<ReturnType<typeof context>>, selected: SkillPackSkill[], mode: "install" | "update" | "explicit"): Promise<SkillPackInstallResult> {
  const { catalogue, source, pack, paths, state, options } = ctx; const linkMode = options.linkMode ?? "symlink";
  if (linkMode !== "symlink" && linkMode !== "copy") throw new Error(`Invalid link mode: ${linkMode}`);
  const previousPack = state.packs[pack.id]; const manifestSha256 = manifestDigest(pack);
  if (mode === "update" && previousPack?.version === pack.version && previousPack.manifestSha256 !== manifestSha256) {
    throw new Error(`Skill Pack ${pack.id} version ${pack.version} changed manifest content; publish a new pack version`);
  }
  preflight(selected, pack.id, state, paths.homeDir, source, mode);
  const staging = mkdtempSync(join(tmpdir(), "agent-bridge-skill-pack-")); const repoRoot = join(staging, "repo"); const prepared: Prepared[] = [];
  try {
    for (const skill of selected) prepared.push(await prepare(skill, source, repoRoot, options.fetchImpl ?? fetch));
    const staged = new Set(listLocalCatalog(repoRoot).map((entry) => entry.name)); for (const skill of selected) if (!staged.has(skill.id)) throw new Error(`Prepared Skill is invalid: ${skill.id}`);
    const now = (options.now ?? new Date()).toISOString(); const installed: string[] = []; const retained: string[] = [];
    for (const item of prepared) {
      const previous = state.skills[item.skill.id]; const registration = coreRegistration(item.skill.id, paths.homeDir);
      const refs = new Set(previous?.packRefs ?? []); if (mode !== "explicit") refs.add(pack.id); const explicit = mode === "explicit" || Boolean(previous?.explicit);
      commitNotice(item, paths);
      // Persist the desired pack-owned state before mutating the core Skill. If the
      // process is interrupted after the core install starts, the next explicit
      // pack operation can identify and converge the orphan instead of treating it
      // as unrelated user-owned content.
      state.skills[item.skill.id] = { explicit, packRefs: [...refs].sort(), description: item.skill.description, content: { ...item.skill.content, repository: item.repository }, provenance: item.skill.provenance, supportedHosts: item.skill.supportedHosts, dependencies: item.skill.dependencies, capabilities: item.skill.capabilities, tests: item.skill.tests, installedAt: previous?.installedAt ?? now, updatedAt: now, noticeLocalPath: item.notice ? relative(paths.homeDir, join(paths.notices, item.skill.id, basename(item.notice))).split("\\").join("/") : previous?.noticeLocalPath };
      writeState(paths.lockfile, state);
      const canonical = join(resolveSkillPaths(paths.homeDir).agentsSkillsDir, item.skill.id);
      const unchanged = Boolean(registration) && previous && sameSkillContract(previous, item.skill, item.repository, source)
        && existsSync(canonical) && hashSkillPackDirectorySha256(canonical) === item.skill.content.sha256
        && verifySkillGlobal(item.skill.id, { homeDir: paths.homeDir }).ok;
      if (registration && unchanged) retained.push(item.skill.id);
      else {
        installSkillGlobal(item.skill.id, { repoRoot, homeDir: paths.homeDir, force: Boolean(registration), linkMode, ownership: "user", now: options.now, projectCursor: Boolean(registration?.cursorProjected) });
        installed.push(item.skill.id);
      }
    }
    const removed: string[] = [];
    if (mode === "update" && previousPack) for (const skillId of previousPack.skills) if (!selected.some((skill) => skill.id === skillId)) {
      id(skillId, `installed Skill id in pack ${pack.id}`);
      const record = state.skills[skillId]; if (!record) throw new Error(`Skill Pack state is inconsistent: missing skill ${skillId}`);
      record.packRefs = record.packRefs.filter((ref) => ref !== pack.id); record.updatedAt = now;
      if (!record.explicit && !record.packRefs.length) { uninstallPackSkill(skillId, paths.homeDir); removeNotice(record.noticeLocalPath, paths.homeDir); delete state.skills[skillId]; removed.push(skillId); }
    }
    if (mode !== "explicit") {
      state.packs[pack.id] = { version: pack.version, manifestSha256, catalogueId: catalogue.catalogueId, catalogueVersion: catalogue.catalogueVersion, catalogueSource: source, skills: pack.skills.map((skill) => skill.id).sort(), manifest: pack, installedAt: previousPack?.installedAt ?? now, updatedAt: now };
      mkdirSync(paths.manifests, { recursive: true }); atomicJson(join(paths.manifests, `${pack.id}.json`), { schemaVersion: catalogue.schemaVersion, catalogueId: catalogue.catalogueId, catalogueVersion: catalogue.catalogueVersion, pack });
    }
    writeState(paths.lockfile, state); return { packId: pack.id, version: pack.version, installed, retained, removed };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function preflight(selected: SkillPackSkill[], packId: string, state: PackState, homeDir: string, source: string, mode: "install" | "update" | "explicit"): void {
  const paths = resolveSkillPaths(homeDir);
  for (const skill of selected) {
    const prior = state.skills[skill.id]; const registration = coreRegistration(skill.id, homeDir); const canonical = join(paths.agentsSkillsDir, skill.id); const repository = contentRepository(skill.content.repository, source);
    if (!registration && existsSync(canonical)) throw new Error(`Refusing pack install over unregistered shared Skill: ${skill.id}`);
    if (registration?.ownership === "bundled") throw new Error(`Refusing pack install over bundled-owned Skill: ${skill.id}`);
    if (registration?.ownership === "user" && !prior) throw new Error(`Refusing pack install over user-owned Skill: ${skill.id}`);
    if (registration && prior) assertManagedProjectionSafe(skill.id, paths, registration);
    if (!registration && prior && !sameSkillContract(prior, skill, repository, source)) throw new Error(`Skill Pack state is inconsistent for missing pack-managed Skill: ${skill.id}`);
    if (!registration) for (const dir of [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir]) if (pathExists(join(dir, skill.id))) throw new Error(`Refusing pack install over unmanaged native Skill path: ${join(dir, skill.id)}`);
    if (!prior || sameSkillContract(prior, skill, repository, source)) continue;
    if (mode === "install") throw new Error(`Skill Pack state is inconsistent for interrupted install of ${skill.id}`);
    if (mode === "explicit") {
      if (prior.packRefs.length) throw new Error(`Cannot change Skill ${skill.id} through an explicit install while referenced by installed packs: ${prior.packRefs.join(", ")}`);
      continue;
    }
    const others = prior.packRefs.filter((ref) => ref !== packId); if (others.length) throw new Error(`Cannot change shared Skill ${skill.id}; still referenced by packs: ${others.join(", ")}`);
    if (prior.explicit) throw new Error(`Cannot change explicitly installed Skill ${skill.id} during pack convergence`);
  }
}

async function prepare(skill: SkillPackSkill, catalogueSource: string, repoRoot: string, fetchImpl: typeof fetch): Promise<Prepared> {
  const repository = contentRepository(skill.content.repository, catalogueSource); const target = join(repoRoot, "skills", skill.id); mkdirSync(dirname(target), { recursive: true });
  if (githubRepo(repository)) { if (!/^[0-9a-f]{40}$/i.test(skill.content.revision)) throw new Error(`GitHub Skill content revision must be an exact 40-character commit SHA: ${skill.id}`); await githubDirectory(repository, skill.content.revision, skill.content.path, target, fetchImpl); }
  else { const from = safeJoin(localRepo(repository), skill.content.path, `Skill content path for ${skill.id}`); if (!existsSync(from) || !lstatSync(from).isDirectory()) throw new Error(`Skill content directory does not exist: ${from}`); cpSync(from, target, { recursive: true }); }
  const actual = hashSkillPackDirectorySha256(target); if (actual !== skill.content.sha256) throw new Error(`Skill content checksum mismatch for ${skill.id}: expected ${skill.content.sha256}, got ${actual}`);
  let notice: string | undefined;
  if (skill.provenance.noticePath) {
    notice = join(dirname(repoRoot), "notices", skill.id, basename(skill.provenance.noticePath)); mkdirSync(dirname(notice), { recursive: true });
    if (githubRepo(repository)) writeFileSync(notice, await githubFile(repository, skill.content.revision, skill.provenance.noticePath, fetchImpl));
    else { const from = safeJoin(localRepo(repository), skill.provenance.noticePath, `notice path for ${skill.id}`); if (!existsSync(from) || !lstatSync(from).isFile()) throw new Error(`Provenance notice does not exist: ${from}`); cpSync(from, notice); }
    if (fileSha256(notice) !== skill.provenance.noticeSha256) throw new Error(`Provenance notice checksum mismatch for ${skill.id}`);
  }
  return { skill, repository, notice };
}

function commitNotice(item: Prepared, paths: Paths): void { if (!item.notice) return; const target = join(paths.notices, item.skill.id, basename(item.notice)); mkdirSync(dirname(target), { recursive: true }); cpSync(item.notice, target); }

async function githubDirectory(repository: string, revision: string, sourcePath: string, target: string, fetchImpl: typeof fetch): Promise<void> {
  const { owner, repo } = githubParts(repository); const tree = JSON.parse(await fetchText(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${revision}?recursive=1`, fetchImpl, maxTreeBytes)) as { truncated?: boolean; tree?: Array<{ path?: string; type?: string; mode?: string }> };
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error(`Invalid or truncated GitHub tree for ${repository}@${revision}`);
  const prefix = relPath(sourcePath, "Skill content path"), slash = `${prefix}/`; const entries = tree.tree.filter((entry) => entry.type === "blob" && typeof entry.path === "string" && entry.path.startsWith(slash));
  if (!entries.length) throw new Error(`No files found at ${repository}@${revision}:${prefix}`); if (entries.length > maxSkillFiles) throw new Error(`Skill content exceeds ${maxSkillFiles} files`);
  let total = 0; for (const entry of entries) { if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error(`Unsupported GitHub Skill file mode ${String(entry.mode)}`); const bytes = await githubFile(repository, revision, entry.path!, fetchImpl); total += bytes.length; if (total > maxSkillBytes) throw new Error(`Skill content exceeds ${maxSkillBytes} bytes`); const dest = safeJoin(target, entry.path!.slice(slash.length), "GitHub Skill file path"); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes); if (entry.mode === "100755") chmodSync(dest, 0o755); }
}

async function githubFile(repository: string, revision: string, path: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const { owner, repo } = githubParts(repository); const encoded = relPath(path, "GitHub file path").split("/").map(encodeURIComponent).join("/"); return fetchBytes(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${revision}/${encoded}`, fetchImpl, maxSkillBytes);
}

function validateCatalogue(raw: unknown): SkillPackCatalogue {
  record(raw, "Skill Pack catalogue"); only(raw, ["schemaVersion", "catalogueId", "catalogueVersion", "packs"], "Skill Pack catalogue"); if (raw.schemaVersion !== 1) throw new Error(`Unsupported Skill Pack catalogue schemaVersion: ${String(raw.schemaVersion)}`);
  const catalogueId = text(raw.catalogueId, "catalogueId", 128), catalogueVersion = semver(raw.catalogueVersion, "catalogueVersion"); if (!Array.isArray(raw.packs)) throw new Error("Skill Pack catalogue packs must be an array"); const packs = raw.packs.map((item, index) => validatePack(item, `packs[${index}]`)); unique(packs.map((pack) => `${pack.id}@${pack.version}`), "pack id/version"); return { schemaVersion: 1, catalogueId, catalogueVersion, packs };
}

function validatePack(raw: unknown, label: string): SkillPackManifest {
  record(raw, label); only(raw, ["id","displayName","description","version","maintainer","license","categories","capabilityTags","attribution","compatibility","dependencies","capabilities","tests","skills"], label);
  if (!Array.isArray(raw.skills) || !raw.skills.length) throw new Error(`${label}.skills must be a non-empty array`); const skills = raw.skills.map((item, index) => validateSkill(item, `${label}.skills[${index}]`)); const packId = id(raw.id, `${label}.id`); unique(skills.map((skill) => skill.id), `Skill id in ${packId}`);
  return { id: packId, displayName: text(raw.displayName, `${label}.displayName`, 160), description: text(raw.description, `${label}.description`, 1024), version: semver(raw.version, `${label}.version`), maintainer: text(raw.maintainer, `${label}.maintainer`, 256), license: spdx(raw.license, `${label}.license`), categories: strings(raw.categories, `${label}.categories`, 32, 64), capabilityTags: strings(raw.capabilityTags, `${label}.capabilityTags`, 64, 96), attribution: strings(raw.attribution, `${label}.attribution`, 64, 512), compatibility: compatibility(raw.compatibility, `${label}.compatibility`), dependencies: dependencies(raw.dependencies, `${label}.dependencies`), capabilities: capabilities(raw.capabilities, `${label}.capabilities`), tests: strings(raw.tests, `${label}.tests`, 64, 512), skills };
}

function validateSkill(raw: unknown, label: string): SkillPackSkill {
  record(raw, label); only(raw, ["id","description","content","provenance","supportedHosts","dependencies","capabilities","tests"], label); const hosts = strings(raw.supportedHosts, `${label}.supportedHosts`, 16, 64); if (!hosts.length) throw new Error(`${label}.supportedHosts must not be empty`);
  return { id: id(raw.id, `${label}.id`), description: text(raw.description, `${label}.description`, 1024), content: content(raw.content, `${label}.content`), provenance: provenance(raw.provenance, `${label}.provenance`), supportedHosts: hosts, dependencies: dependencies(raw.dependencies, `${label}.dependencies`), capabilities: capabilities(raw.capabilities, `${label}.capabilities`), tests: strings(raw.tests, `${label}.tests`, 64, 512) };
}

function content(raw: unknown, label: string): SkillContentRef { record(raw, label); only(raw, ["repository","revision","path","sha256"], label); return { repository: text(raw.repository, `${label}.repository`, 2048), revision: text(raw.revision, `${label}.revision`, 160), path: relPath(text(raw.path, `${label}.path`, 1024), `${label}.path`), sha256: sha(raw.sha256, `${label}.sha256`) }; }
function provenance(raw: unknown, label: string): SkillProvenance {
  record(raw, label); only(raw, ["origin","upstreamRepository","upstreamRevision","upstreamLicense","noticePath","noticeSha256","modifiedFromUpstream","lastReviewed"], label); const origin = raw.origin; if (origin !== "farstax-authored" && origin !== "adapted-upstream" && origin !== "vendored-upstream") throw new Error(`${label}.origin is invalid`); if (typeof raw.modifiedFromUpstream !== "boolean") throw new Error(`${label}.modifiedFromUpstream must be boolean`); const base: SkillProvenance = { origin, modifiedFromUpstream: raw.modifiedFromUpstream, lastReviewed: isoDate(raw.lastReviewed, `${label}.lastReviewed`) };
  if (origin === "farstax-authored") { if (raw.modifiedFromUpstream || [raw.upstreamRepository,raw.upstreamRevision,raw.upstreamLicense,raw.noticePath,raw.noticeSha256].some((value) => value !== undefined)) throw new Error(`${label} has invalid upstream provenance for farstax-authored content`); return base; }
  const upstreamRepository = https(raw.upstreamRepository, `${label}.upstreamRepository`), upstreamRevision = text(raw.upstreamRevision, `${label}.upstreamRevision`, 160); if (/^https:\/\/github\.com\//i.test(upstreamRepository) && !/^[0-9a-f]{40}$/i.test(upstreamRevision)) throw new Error(`${label}.upstreamRevision must be an exact 40-character commit SHA for GitHub upstreams`);
  return { ...base, upstreamRepository, upstreamRevision, upstreamLicense: spdx(raw.upstreamLicense, `${label}.upstreamLicense`), noticePath: relPath(text(raw.noticePath, `${label}.noticePath`, 1024), `${label}.noticePath`), noticeSha256: sha(raw.noticeSha256, `${label}.noticeSha256`) };
}
function compatibility(raw: unknown, label: string) { record(raw, label); only(raw, ["apiVersion","minAgentBridgeVersion","maxAgentBridgeVersion","supportedHosts"], label); if (raw.apiVersion !== 1) throw new Error(`${label}.apiVersion is incompatible: ${String(raw.apiVersion)}`); return { apiVersion: 1, minAgentBridgeVersion: raw.minAgentBridgeVersion === undefined ? undefined : semver(raw.minAgentBridgeVersion, `${label}.minAgentBridgeVersion`), maxAgentBridgeVersion: raw.maxAgentBridgeVersion === undefined ? undefined : semver(raw.maxAgentBridgeVersion, `${label}.maxAgentBridgeVersion`), supportedHosts: strings(raw.supportedHosts, `${label}.supportedHosts`, 16, 64) }; }
function dependencies(raw: unknown, label: string): SkillPackDependencies { record(raw, label); only(raw, ["requiredLocal","optionalLocal","externalServices","hostedMcps","requiredSecrets"], label); return { requiredLocal: named(raw.requiredLocal, `${label}.requiredLocal`), optionalLocal: named(raw.optionalLocal, `${label}.optionalLocal`), externalServices: services(raw.externalServices, `${label}.externalServices`), hostedMcps: services(raw.hostedMcps, `${label}.hostedMcps`), requiredSecrets: named(raw.requiredSecrets, `${label}.requiredSecrets`, true) }; }
function named(raw: unknown, label: string, secret = false): NamedRequirement[] { if (raw === undefined) return []; if (!Array.isArray(raw)) throw new Error(`${label} must be an array`); return raw.map((item, index) => { record(item, `${label}[${index}]`); only(item, ["name","purpose"], `${label}[${index}]`); const name = text(item.name, `${label}[${index}].name`, 128); if (secret && !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`${label}[${index}].name must be an environment-style secret name`); return { name, purpose: text(item.purpose, `${label}[${index}].purpose`, 512) }; }); }
function services(raw: unknown, label: string): ServiceRequirement[] { if (raw === undefined) return []; if (!Array.isArray(raw)) throw new Error(`${label} must be an array`); return raw.map((item, index) => { record(item, `${label}[${index}]`); only(item, ["name","purpose","url","authorization"], `${label}[${index}]`); return { name: text(item.name, `${label}[${index}].name`, 128), purpose: text(item.purpose, `${label}[${index}].purpose`, 512), url: item.url === undefined ? undefined : https(item.url, `${label}[${index}].url`), authorization: item.authorization === undefined ? undefined : text(item.authorization, `${label}[${index}].authorization`, 160) }; }); }
function capabilities(raw: unknown, label: string): SkillPackCapabilities { record(raw, label); only(raw, ["effects","approval"], label); if (!Array.isArray(raw.effects)) throw new Error(`${label}.effects must be an array`); const allowed = new Set<SkillPackEffect>(["local-read","external-read","draft-write","external-write","spend-mutation"]); const effects = raw.effects.map((value, index) => { if (typeof value !== "string" || !allowed.has(value as SkillPackEffect)) throw new Error(`${label}.effects[${index}] is invalid`); return value as SkillPackEffect; }); return { effects: [...new Set(effects)], approval: text(raw.approval, `${label}.approval`, 512) }; }

function selectPack(catalogue: SkillPackCatalogue, packId: string, requested?: string): SkillPackManifest { const candidates = catalogue.packs.filter((pack) => pack.id === packId); if (!candidates.length) throw new Error(`Unknown Skill Pack: ${packId}`); if (requested) { semver(requested, "requested Skill Pack version"); const exact = candidates.find((pack) => pack.version === requested); if (!exact) throw new Error(`Skill Pack ${packId} version ${requested} is not in this catalogue`); return exact; } return candidates.sort((a,b) => compareVersion(b.version,a.version))[0]; }
function compatible(pack: SkillPackManifest, current: string): void { if (pack.compatibility.minAgentBridgeVersion && compareVersion(current, pack.compatibility.minAgentBridgeVersion) < 0) throw new Error(`Skill Pack ${pack.id} requires Agent Bridge >= ${pack.compatibility.minAgentBridgeVersion}; current ${current}`); if (pack.compatibility.maxAgentBridgeVersion && compareVersion(current, pack.compatibility.maxAgentBridgeVersion) > 0) throw new Error(`Skill Pack ${pack.id} requires Agent Bridge <= ${pack.compatibility.maxAgentBridgeVersion}; current ${current}`); }
function bridgeVersion(options: SkillPackManagerOptions): string { if (options.agentBridgeVersion) return options.agentBridgeVersion; if (process.env.AGENT_BRIDGE_VERSION) return process.env.AGENT_BRIDGE_VERSION; try { const value = JSON.parse(readFileSync(join(options.repoRoot ?? defaultRepoRoot, "package.json"), "utf8")) as { version?: unknown }; if (typeof value.version === "string") return value.version; } catch {} throw new Error("Unable to determine current Agent Bridge version for Skill Pack compatibility"); }

function coreRegistration(skillId: string, homeDir: string): CoreRegistration | undefined { const path = resolveSkillPaths(homeDir).lockfilePath; if (!existsSync(path)) return undefined; let raw: unknown; try { raw = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new Error(`Unable to parse skill lockfile: ${path}`); } if (!isRecord(raw) || !isRecord(raw.skills)) throw new Error(`Unable to parse skill lockfile: ${path}`); const value = raw.skills[skillId]; if (value === undefined) return undefined; if (!isRecord(value) || (value.ownership !== "bundled" && value.ownership !== "user")) throw new Error(`Invalid skill registration for ${skillId}`); if (value.linkMode !== undefined && value.linkMode !== "symlink" && value.linkMode !== "copy") throw new Error(`Invalid skill registration link mode for ${skillId}`); if (value.skillFolderHash !== undefined && (typeof value.skillFolderHash !== "string" || !/^[0-9a-f]{40}$/i.test(value.skillFolderHash))) throw new Error(`Invalid skill registration hash for ${skillId}`); return { ownership: value.ownership, linkMode: value.linkMode === "copy" ? "copy" : "symlink", cursorProjected: value.cursorProjected === true, skillFolderHash: typeof value.skillFolderHash === "string" ? value.skillFolderHash : undefined }; }
function assertManagedProjectionSafe(skillId: string, paths: ReturnType<typeof resolveSkillPaths>, registration: CoreRegistration): void { const shared = join(paths.agentsSkillsDir, skillId); const dirs = [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir, ...(registration.cursorProjected ? [paths.cursorSkillsDir] : [])]; for (const dir of dirs) { const native = join(dir, skillId); if (!pathExists(native)) continue; let expected = false; try { const stat = lstatSync(native); expected = registration.linkMode === "symlink" ? stat.isSymbolicLink() && resolve(dirname(native), readlinkSync(native)) === resolve(shared) : Boolean(registration.skillFolderHash) && stat.isDirectory() && hashDirectory(native) === registration.skillFolderHash; } catch {} if (!expected) throw new Error(`Refusing pack convergence over unmanaged native Skill path: ${native}`); } }
function uninstallPackSkill(skillId: string, homeDir: string): void { id(skillId, "pack-managed Skill id"); const registration = coreRegistration(skillId, homeDir); if (!registration) return; if (registration.ownership !== "user") throw new Error(`Refusing to remove non-pack Skill ${skillId}`); assertManagedProjectionSafe(skillId, resolveSkillPaths(homeDir), registration); uninstallSkillGlobal(skillId, { homeDir, expectedOwnership: "user" }); }
function readState(path: string): PackState { if (!existsSync(path)) return { version: 1, packs: {}, skills: {} }; let raw: unknown; try { raw = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new Error(`Unable to parse Skill Pack lockfile: ${path}`); } if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.packs) || !isRecord(raw.skills)) throw new Error(`Invalid Skill Pack lockfile: ${path}`); return raw as PackState; }
function writeState(path: string, state: PackState): void { state.version = 1; atomicJson(path, state); }
function atomicJson(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp.${process.pid}`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); renameSync(temp, path); }
function removeNotice(relativePath: string | undefined, homeDir: string): void { if (!relativePath) return; const path = safeJoin(homeDir, relativePath, "installed notice path"); rmSync(path, { force: true }); try { if (!readdirSync(dirname(path)).length) rmSync(dirname(path), { recursive: true, force: true }); } catch {} }

async function readSource(source: string, fetchImpl: typeof fetch, max: number): Promise<string> { const local = localPath(source); if (local) { const bytes = readFileSync(local); if (bytes.length > max) throw new Error(`Skill Pack catalogue exceeds ${max} bytes`); return bytes.toString("utf8"); } if (!source.startsWith("https://")) throw new Error(`Skill Pack catalogue source must be a local path, file:// URL, or HTTPS URL: ${source}`); const url = new URL(source); if (url.hostname !== "raw.githubusercontent.com" || !url.pathname.startsWith("/Farstax/agent-bridge-skills/")) throw new Error(`Remote Skill Pack catalogues are restricted to the curated Farstax/agent-bridge-skills repository: ${source}`); return fetchText(source, fetchImpl, max); }
async function fetchText(url: string, fetchImpl: typeof fetch, max: number): Promise<string> { return (await fetchBytes(url, fetchImpl, max)).toString("utf8"); }
async function fetchBytes(url: string, fetchImpl: typeof fetch, max: number): Promise<Buffer> { const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), fetchTimeoutMs); try { const response = await fetchImpl(url, { signal: controller.signal, headers: { "user-agent": "agent-bridge-skill-pack-manager" } }); if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > max) throw new Error(`Response exceeds ${max} bytes: ${url}`); return bytes; } finally { clearTimeout(timeout); } }
function contentRepository(repository: string, catalogueSource: string): string {
  if (githubRepo(repository)) return repository.replace(/\.git$/, "");
  const catalogue = localPath(catalogueSource);
  if (repository.startsWith("file://") || isAbsolute(repository)) {
    if (!catalogue) throw new Error(`Local Skill content repository requires a local catalogue: ${repository}`);
    return repository;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(repository)) throw new Error(`Unsupported Skill content repository: ${repository}`);
  if (!catalogue) throw new Error(`Relative Skill content repository requires a local catalogue: ${repository}`);
  return resolve(dirname(catalogue), repository);
}
function localPath(source: string): string | null { if (source.startsWith("file://")) return fileURLToPath(source); if (isAbsolute(source) || !/^[a-z][a-z0-9+.-]*:/i.test(source)) return resolve(source); return null; }
function localRepo(repository: string): string { if (repository.startsWith("file://")) return fileURLToPath(repository); if (isAbsolute(repository)) return repository; throw new Error(`Skill content repository is not local: ${repository}`); }
function githubRepo(repository: string): boolean { return /^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/i.test(repository); }
function githubParts(repository: string): { owner: string; repo: string } { const match = repository.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i); if (!match) throw new Error(`Unsupported GitHub repository URL: ${repository}`); return { owner: match[1], repo: match[2] }; }
function sameContent(installed: SkillContentRef, candidate: SkillContentRef, resolvedRepository: string, catalogueSource: string): boolean { return contentRepository(installed.repository, catalogueSource) === resolvedRepository && installed.revision === candidate.revision && installed.path === candidate.path && installed.sha256 === candidate.sha256; }
function sameSkillContract(installed: InstalledSkill, candidate: SkillPackSkill, resolvedRepository: string, catalogueSource: string): boolean { if (!sameContent(installed.content, candidate.content, resolvedRepository, catalogueSource) || installed.description !== candidate.description) return false; return JSON.stringify(stable({ provenance: installed.provenance, supportedHosts: installed.supportedHosts, dependencies: installed.dependencies, capabilities: installed.capabilities, tests: installed.tests })) === JSON.stringify(stable({ provenance: candidate.provenance, supportedHosts: candidate.supportedHosts, dependencies: candidate.dependencies, capabilities: candidate.capabilities, tests: candidate.tests })); }

function files(dir: string): string[] { const result: string[] = []; for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const full = join(dir, entry.name); if (entry.isDirectory()) result.push(...files(full)); else if (entry.isFile()) result.push(full); else throw new Error(`Unsupported Skill Pack filesystem entry: ${full}`); } return result; }
function fileSha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function safeJoin(root: string, value: string, label: string): string { const normalized = relPath(value, label), target = resolve(root, normalized), rel = relative(resolve(root), target); if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes its repository root`); return target; }
function relPath(value: string, label: string): string { const normalized = value.replace(/\\/g, "/").replace(/^\.\//, ""); if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "..")) throw new Error(`${label} must be a safe relative path`); return normalized; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string <= ${max} characters`); return value; }
function strings(value: unknown, label: string, maxItems: number, maxLength: number): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with <= ${maxItems} items`); return value.map((item,index) => text(item, `${label}[${index}]`, maxLength)); }
function id(value: unknown, label: string): string { const result = text(value, label, 64); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new Error(`${label} must be lowercase kebab-case`); return result; }
function semver(value: unknown, label: string): string { const result = text(value, label, 64); if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result)) throw new Error(`${label} must be semantic version x.y.z`); return result; }
function compareVersion(a: string, b: string): number { const parse = (value: string) => { const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/); if (!match) throw new Error(`Invalid semantic version: ${value}`); return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") ?? [] }; }; const av = parse(a), bv = parse(b); for (let i=0;i<3;i+=1) if (av.core[i] !== bv.core[i]) return av.core[i] < bv.core[i] ? -1 : 1; if (!av.pre.length || !bv.pre.length) return av.pre.length === bv.pre.length ? 0 : av.pre.length ? -1 : 1; for (let i=0;i<Math.max(av.pre.length,bv.pre.length);i+=1) { if (av.pre[i] === undefined) return -1; if (bv.pre[i] === undefined) return 1; if (av.pre[i] === bv.pre[i]) continue; const an = /^\d+$/.test(av.pre[i]), bn = /^\d+$/.test(bv.pre[i]); if (an && bn) return Number(av.pre[i]) < Number(bv.pre[i]) ? -1 : 1; if (an !== bn) return an ? -1 : 1; return av.pre[i] < bv.pre[i] ? -1 : 1; } return 0; }
function manifestDigest(pack: SkillPackManifest): string { return createHash("sha256").update(JSON.stringify(stable(pack))).digest("hex"); }
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (!isRecord(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); }
function sha(value: unknown, label: string): string { const result = text(value, label, 64); if (!/^[0-9a-f]{64}$/i.test(result)) throw new Error(`${label} must be a 64-character SHA-256`); return result.toLowerCase(); }
function spdx(value: unknown, label: string): string { const result = text(value, label, 128); if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(result)) throw new Error(`${label} must be an SPDX-style licence id`); return result; }
function https(value: unknown, label: string): string { const result = text(value, label, 2048); let url: URL; try { url = new URL(result); } catch { throw new Error(`${label} must be a valid HTTPS URL`); } if (url.protocol !== "https:") throw new Error(`${label} must be a valid HTTPS URL`); return result; }
function isoDate(value: unknown, label: string): string { const result = text(value, label, 32); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) throw new Error(`${label} must be YYYY-MM-DD`); return result; }
function record(value: unknown, label: string): asserts value is Record<string, unknown> { if (!isRecord(value)) throw new Error(`${label} must be an object`); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function only(value: Record<string, unknown>, allowed: string[], label: string): void { const set = new Set(allowed), unknown = Object.keys(value).filter((key) => !set.has(key)); if (unknown.length) throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}`); }
function unique(values: string[], label: string): void { const seen = new Set<string>(); for (const value of values) { if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`); seen.add(value); } }
function pathExists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
