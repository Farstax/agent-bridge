#!/usr/bin/env tsx

import {
  installSkillGlobal,
  listLocalCatalog,
  projectManagedSkillToCursor,
  uninstallSkillGlobal,
  verifySkillGlobal,
  type SkillLinkMode,
} from "../src/skills.js";
import {
  getAvailableSkillCollection,
  getSkillCollectionStatus,
  installManagedSkill,
  installSkillCollection,
  listAvailableSkillCollections,
  removeManagedSkill,
  removeSkillCollection,
  updateSkillCollection,
  type SkillCollectionManagerOptions,
} from "../src/skillCollections.js";
import { projectUserSkillGlobal, uninstallUserSkillGlobal } from "../src/userSkills.js";

function usage(): never {
  console.error([
    "Usage:",
    "  npx tsx scripts/skill-manager.ts list",
    "  npx tsx scripts/skill-manager.ts install <skill-name> [--force] [--link-mode symlink|copy] [--project-cursor]",
    "  npx tsx scripts/skill-manager.ts install <skill-name> --catalogue <source> [--link-mode symlink|copy]",
    "  npx tsx scripts/skill-manager.ts project-user <skill-name> [--project-cursor]",
    "  npx tsx scripts/skill-manager.ts project-cursor <skill-name> [--link-mode symlink|copy]",
    "  npx tsx scripts/skill-manager.ts verify [<skill-name>] [--fix]",
    "  npx tsx scripts/skill-manager.ts uninstall-user <skill-name>",
    "  npx tsx scripts/skill-manager.ts uninstall <skill-name>",
    "  npx tsx scripts/skill-manager.ts collections list [--catalogue <source>]",
    "  npx tsx scripts/skill-manager.ts collections show <collection-id> [--catalogue <source>]",
    "  npx tsx scripts/skill-manager.ts collections status",
    "  npx tsx scripts/skill-manager.ts collections install <collection-id> [--catalogue <source>] [--link-mode symlink|copy]",
    "  npx tsx scripts/skill-manager.ts collections update <collection-id> [--catalogue <source>] [--link-mode symlink|copy]",
    "  npx tsx scripts/skill-manager.ts collections remove <collection-id>",
  ].join("\n"));
  process.exit(1);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function parseLinkMode(value: string | null): SkillLinkMode {
  if (value === null) return "symlink";
  if (value === "symlink" || value === "copy") return value;
  throw new Error(`Invalid --link-mode value: ${value}`);
}

function collectionOptions(args: string[], includeLinkMode = false): SkillCollectionManagerOptions {
  return {
    catalogueSource: optionValue(args, "--catalogue") ?? undefined,
    linkMode: includeLinkMode ? parseLinkMode(optionValue(args, "--link-mode")) : undefined,
  };
}

async function runCollectionCommand(subcommand: string | undefined, args: string[]): Promise<void> {
  if (subcommand === "list") {
    for (const collection of await listAvailableSkillCollections(collectionOptions(args))) {
      console.log(`${collection.id}\t${collection.name}\t${collection.description}\t${collection.skills.length} Skills`);
    }
    return;
  }
  if (subcommand === "show") {
    const [collectionId, ...rest] = args;
    if (!collectionId) usage();
    console.log(JSON.stringify(await getAvailableSkillCollection(collectionId, collectionOptions(rest)), null, 2));
    return;
  }
  if (subcommand === "status") {
    console.log(JSON.stringify(getSkillCollectionStatus(), null, 2));
    return;
  }
  if (subcommand === "install") {
    const [collectionId, ...rest] = args;
    if (!collectionId) usage();
    console.log(JSON.stringify(await installSkillCollection(collectionId, collectionOptions(rest, true)), null, 2));
    return;
  }
  if (subcommand === "update") {
    const [collectionId, ...rest] = args;
    if (!collectionId) usage();
    console.log(JSON.stringify(await updateSkillCollection(collectionId, collectionOptions(rest, true)), null, 2));
    return;
  }
  if (subcommand === "remove") {
    const [collectionId] = args;
    if (!collectionId) usage();
    console.log(JSON.stringify(removeSkillCollection(collectionId), null, 2));
    return;
  }
  usage();
}

async function main(): Promise<void> {
  const [command, maybeSkillName, ...rest] = process.argv.slice(2);

  if (command === "collections") {
    await runCollectionCommand(maybeSkillName, rest);
    return;
  }
  if (command === "list") {
    for (const entry of listLocalCatalog()) console.log(`${entry.name}\t${entry.version}\t${entry.description}`);
    return;
  }
  if (command === "install") {
    if (!maybeSkillName) usage();
    const catalogue = optionValue(rest, "--catalogue");
    const linkMode = parseLinkMode(optionValue(rest, "--link-mode"));
    if (catalogue) {
      console.log(JSON.stringify(await installManagedSkill(maybeSkillName, { catalogueSource: catalogue, linkMode }), null, 2));
      return;
    }
    installSkillGlobal(maybeSkillName, { force: hasFlag(rest, "--force"), linkMode, projectCursor: hasFlag(rest, "--project-cursor") });
    console.log(`Installed ${maybeSkillName} (${linkMode}${hasFlag(rest, "--project-cursor") ? ", cursor" : ""})`);
    return;
  }
  if (command === "project-user") {
    if (!maybeSkillName) usage();
    projectUserSkillGlobal(maybeSkillName, { projectCursor: hasFlag(rest, "--project-cursor") });
    console.log(`Projected user skill ${maybeSkillName} (symlink${hasFlag(rest, "--project-cursor") ? ", cursor" : ""})`);
    return;
  }
  if (command === "project-cursor") {
    if (!maybeSkillName) usage();
    const linkMode = parseLinkMode(optionValue(rest, "--link-mode"));
    projectManagedSkillToCursor(maybeSkillName, { linkMode });
    console.log(`Projected Cursor skill ${maybeSkillName} (${linkMode})`);
    return;
  }
  if (command === "verify") {
    const skillName = maybeSkillName?.startsWith("--") ? undefined : maybeSkillName;
    const args = skillName ? rest : [maybeSkillName, ...rest].filter((arg): arg is string => Boolean(arg));
    const result = verifySkillGlobal(skillName, { fix: hasFlag(args, "--fix") });
    for (const repaired of result.repaired) console.log(`Repaired ${repaired}`);
    if (!result.ok) {
      for (const error of result.errors) console.error(error);
      process.exit(1);
    }
    console.log("Skill verification passed");
    return;
  }
  if (command === "uninstall-user") {
    if (!maybeSkillName) usage();
    uninstallUserSkillGlobal(maybeSkillName);
    console.log(`Uninstalled user skill ${maybeSkillName}`);
    return;
  }
  if (command === "uninstall") {
    if (!maybeSkillName) usage();
    const managed = getSkillCollectionStatus().skills[maybeSkillName];
    if (managed) {
      if (!managed.explicit) throw new Error(`Skill ${maybeSkillName} is installed only through Collection(s): ${managed.collectionRefs.join(", ")}; remove those Collections instead`);
      console.log(JSON.stringify(removeManagedSkill(maybeSkillName), null, 2));
      return;
    }
    uninstallSkillGlobal(maybeSkillName);
    console.log(`Uninstalled ${maybeSkillName}`);
    return;
  }
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
