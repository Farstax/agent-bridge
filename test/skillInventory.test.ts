import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listInstalledSkillInventory } from "../src/skillInventory.js";
import {
  hashDirectory,
  installSkillGlobal,
  projectManagedSkillToCursor,
  resolveSkillPaths,
} from "../src/skills.js";
import {
  hashSkillCollectionDirectorySha256,
  installManagedSkill,
  installSkillCollection,
} from "../src/skillCollections.js";
import { projectUserSkillGlobal } from "../src/userSkills.js";

const tempDirs: string[] = [];
const upstreamRevision = "0123456789abcdef0123456789abcdef01234567";
const skillManager = resolve(process.cwd(), "scripts/skill-manager.ts");
const tsxBin = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");

function temp(label: string): string {
  const dir = join(tmpdir(), `agent-bridge-inventory-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, relativePath: string, id: string, description: string): string {
  const dir = join(root, relativePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n`);
  return dir;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function managedSkill(id: string, repo: string, path: string) {
  const notice = join(repo, "NOTICE.txt");
  if (!existsSync(notice)) writeFileSync(notice, "MIT upstream notice\n");
  return {
    id,
    description: `${id} from a curated fixture.`,
    content: {
      repository: repo,
      revision: upstreamRevision,
      path,
      sha256: hashSkillCollectionDirectorySha256(join(repo, path)),
    },
    provenance: {
      origin: "adapted-upstream" as const,
      upstreamRepository: "https://github.com/example/upstream",
      upstreamRevision,
      upstreamLicense: "MIT",
      noticePath: "NOTICE.txt",
      noticeSha256: hashFile(notice),
      modifiedFromUpstream: true,
      lastReviewed: "2026-09-15",
    },
  };
}

function writeCatalogue(
  root: string,
  skills: ReturnType<typeof managedSkill>[],
  collections: Array<{ id: string; name: string; description: string; skills: string[] }>,
): string {
  const path = join(root, "catalogue.json");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 2,
    catalogueId: "inventory-test-catalogue",
    skills,
    collections,
  }, null, 2)}\n`);
  return path;
}

function runInventoryCommand(home: string): unknown {
  const stdout = execFileSync(process.execPath, [tsxBin, skillManager, "inventory"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, SHARED_MEMORY_HOME: home },
  });
  return JSON.parse(stdout) as unknown;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("installed Skill inventory", () => {
  it("returns canonical bundled and user Skills once without lifecycle metadata or provider-native content", () => {
    const home = temp("canonical");
    const paths = resolveSkillPaths(home);
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });

    writeSkill(paths.agentsSkillsDir, "user-authored", "user-authored", "User-authored capability.");
    projectUserSkillGlobal("user-authored", { homeDir: home });
    projectManagedSkillToCursor("requirements-to-acceptance", { homeDir: home });

    writeSkill(paths.cursorSkillsDir, "provider-only", "provider-only", "Unmanaged provider-native content.");
    writeSkill(paths.agentsSkillsDir, "unregistered-shared", "unregistered-shared", "Unregistered shared content.");
    mkdirSync(join(paths.agentsSkillsDir, "unregistered-broken"), { recursive: true });

    const beforeLockfile = readFileSync(paths.lockfilePath, "utf8");
    const inventory = listInstalledSkillInventory({ homeDir: home });

    expect(inventory.map((entry) => entry.id)).toEqual(["requirements-to-acceptance", "user-authored"]);
    expect(inventory.find((entry) => entry.id === "user-authored")?.description).toBe("User-authored capability.");
    expect(inventory.every((entry) => Object.keys(entry).sort().join(",") === "description,id")).toBe(true);
    expect(inventory).toEqual(listInstalledSkillInventory({ homeDir: home }));
    expect(readFileSync(paths.lockfilePath, "utf8")).toBe(beforeLockfile);

    expect(existsSync(join(paths.cursorSkillsDir, "requirements-to-acceptance", "SKILL.md"))).toBe(true);
    expect(hashDirectory(join(paths.agentsSkillsDir, "requirements-to-acceptance"))).toBe(
      hashDirectory(join(paths.cursorSkillsDir, "requirements-to-acceptance")),
    );
  });

  it("rejects lockfile state rejected by the canonical Skill manager", () => {
    const home = temp("invalid-lock");
    const paths = resolveSkillPaths(home);
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });

    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      skills: Record<string, { ownership?: string }>;
    };
    lockfile.skills["requirements-to-acceptance"].ownership = "invalid";
    writeFileSync(paths.lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/Unable to parse skill lockfile/);
  });

  it.each([
    ["linkMode", "invalid"],
    ["skillFolderHash", "not-a-sha1"],
  ])("rejects an invalid canonical registration %s", (field, value) => {
    const home = temp(`invalid-${field}`);
    const paths = resolveSkillPaths(home);
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });

    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      skills: Record<string, Record<string, unknown>>;
    };
    lockfile.skills["requirements-to-acceptance"][field] = value;
    writeFileSync(paths.lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/Unable to parse skill lockfile/);
  });

  it("rejects a registered ID that escapes the canonical shared Skill directory", () => {
    const home = temp("escaping-id");
    const paths = resolveSkillPaths(home);
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });
    writeSkill(join(home, ".agents"), "outside-skill", "outside-skill", "Outside canonical root.");

    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      skills: Record<string, Record<string, unknown>>;
    };
    lockfile.skills["../outside-skill"] = lockfile.skills["requirements-to-acceptance"];
    delete lockfile.skills["requirements-to-acceptance"];
    writeFileSync(paths.lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/Unable to parse skill lockfile/);
  });

  it("rejects registered content that no longer matches its canonical hash", () => {
    const home = temp("hash-mismatch");
    const paths = resolveSkillPaths(home);
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });
    writeSkill(
      paths.agentsSkillsDir,
      "requirements-to-acceptance",
      "requirements-to-acceptance",
      "Changed after registration.",
    );

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/Installed skill hash mismatch/);
  });

  it("rejects a registered shared Skill directory that is a symlink", () => {
    const home = temp("symlink-directory");
    const paths = resolveSkillPaths(home);
    const outside = writeSkill(home, "outside-skill", "linked-skill", "Outside canonical root.");
    mkdirSync(paths.agentsSkillsDir, { recursive: true });
    symlinkSync(outside, join(paths.agentsSkillsDir, "linked-skill"), "dir");
    writeFileSync(paths.lockfilePath, `${JSON.stringify({
      version: 4,
      skills: {
        "linked-skill": {
          ownership: "user",
          linkMode: "symlink",
          skillFolderHash: hashDirectory(outside),
        },
      },
    }, null, 2)}\n`);

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/Skill directory is invalid/);
  });

  it("rejects a canonical shared Skills root that is a symlink", () => {
    const home = temp("symlink-root");
    const paths = resolveSkillPaths(home);
    const outsideRoot = temp("outside-skills-root");
    const outside = writeSkill(outsideRoot, "skills/linked-skill", "linked-skill", "Outside canonical root.");
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(join(outsideRoot, "skills"), paths.agentsSkillsDir, "dir");
    writeFileSync(paths.lockfilePath, `${JSON.stringify({
      version: 4,
      skills: {
        "linked-skill": {
          ownership: "user",
          linkMode: "symlink",
          skillFolderHash: hashDirectory(outside),
        },
      },
    }, null, 2)}\n`);

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/shared Skills root is not canonical/);
  });

  it("rejects a registered Skill whose SKILL.md is a symlink", () => {
    const home = temp("symlink-metadata");
    const paths = resolveSkillPaths(home);
    const outside = writeSkill(home, "outside-skill", "linked-skill", "Outside canonical root.");
    const shared = join(paths.agentsSkillsDir, "linked-skill");
    mkdirSync(shared, { recursive: true });
    const registeredHash = hashDirectory(shared);
    symlinkSync(join(outside, "SKILL.md"), join(shared, "SKILL.md"));
    writeFileSync(paths.lockfilePath, `${JSON.stringify({
      version: 4,
      skills: {
        "linked-skill": {
          ownership: "user",
          linkMode: "symlink",
          skillFolderHash: registeredHash,
        },
      },
    }, null, 2)}\n`);

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/SKILL.md is not a regular file/);
  });

  it("rejects a registered Skill whose canonical content contains a symlink", () => {
    const home = temp("symlink-content");
    const paths = resolveSkillPaths(home);
    const shared = writeSkill(paths.agentsSkillsDir, "linked-skill", "linked-skill", "Canonical metadata.");
    const registeredHash = hashDirectory(shared);
    const outside = join(home, "outside-asset.txt");
    writeFileSync(outside, "outside content\n");
    symlinkSync(outside, join(shared, "asset.txt"));
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(paths.lockfilePath, `${JSON.stringify({
      version: 4,
      skills: {
        "linked-skill": {
          ownership: "user",
          linkMode: "symlink",
          skillFolderHash: registeredHash,
        },
      },
    }, null, 2)}\n`);

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/unsupported symbolic link/);
  });

  it("rejects a registered Skill whose canonical shared content is missing", () => {
    const home = temp("missing-registered");
    const paths = resolveSkillPaths(home);
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });
    rmSync(join(paths.agentsSkillsDir, "requirements-to-acceptance"), { recursive: true, force: true });

    expect(() => listInstalledSkillInventory({ homeDir: home })).toThrow(/Skill directory is invalid/);
  });

  it("includes directly curated and Collection-installed Skills using intrinsic SKILL.md metadata", async () => {
    const home = temp("curated-home");
    const root = temp("curated-catalogue");
    const repo = join(root, "content");
    writeSkill(repo, "skills/direct-curated", "direct-curated", "Intrinsic direct description.");
    writeSkill(repo, "skills/collection-curated", "collection-curated", "Intrinsic Collection description.");
    const source = writeCatalogue(
      root,
      [
        managedSkill("direct-curated", repo, "skills/direct-curated"),
        managedSkill("collection-curated", repo, "skills/collection-curated"),
      ],
      [{ id: "starter", name: "Starter", description: "Starter curation", skills: ["collection-curated"] }],
    );

    await installManagedSkill("direct-curated", { homeDir: home, catalogueSource: source });
    await installSkillCollection("starter", { homeDir: home, catalogueSource: source });
    const collectionLock = join(home, ".agents", ".skill-collection-lock.json");
    const beforeCollectionState = readFileSync(collectionLock, "utf8");

    expect(listInstalledSkillInventory({ homeDir: home })).toEqual([
      { id: "collection-curated", description: "Intrinsic Collection description." },
      { id: "direct-curated", description: "Intrinsic direct description." },
    ]);
    expect(readFileSync(collectionLock, "utf8")).toBe(beforeCollectionState);
  });

  it("exposes the inventory as deterministic machine-readable CLI JSON", () => {
    const home = temp("cli");
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });

    expect(runInventoryCommand(home)).toEqual(listInstalledSkillInventory({ homeDir: home }));
  });
});
