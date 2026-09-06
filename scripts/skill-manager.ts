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
  importUserSkillGlobal,
  projectUserSkillGlobal,
  uninstallUserSkillGlobal,
} from "../src/userSkills.js";

function usage(): never {
  console.error([
    "Usage:",
    "  npx tsx scripts/skill-manager.ts list",
    "  npx tsx scripts/skill-manager.ts install <skill-name> [--force] [--link-mode symlink|copy] [--project-cursor]",
    "  npx tsx scripts/skill-manager.ts import-user <skill-directory>",
    "  npx tsx scripts/skill-manager.ts project-user <skill-name> [--project-cursor]",
    "  npx tsx scripts/skill-manager.ts project-cursor <skill-name> [--link-mode symlink|copy]",
    "  npx tsx scripts/skill-manager.ts verify [<skill-name>] [--fix]",
    "  npx tsx scripts/skill-manager.ts uninstall-user <skill-name>",
    "  npx tsx scripts/skill-manager.ts uninstall <skill-name>",
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

async function main(): Promise<void> {
  const [command, maybeSkillName, ...rest] = process.argv.slice(2);

  if (command === "list") {
    for (const entry of listLocalCatalog()) {
      console.log(`${entry.name}\t${entry.version}\t${entry.description}`);
    }
    return;
  }

  if (command === "install") {
    if (!maybeSkillName) usage();
    const linkMode = parseLinkMode(optionValue(rest, "--link-mode"));
    installSkillGlobal(maybeSkillName, {
      force: hasFlag(rest, "--force"),
      linkMode,
      projectCursor: hasFlag(rest, "--project-cursor"),
    });
    console.log(`Installed ${maybeSkillName} (${linkMode}${hasFlag(rest, "--project-cursor") ? ", cursor" : ""})`);
    return;
  }

  if (command === "import-user") {
    if (!maybeSkillName) usage();
    const skillName = importUserSkillGlobal(maybeSkillName);
    console.log(`Imported user-managed skill ${skillName} (symlink)`);
    return;
  }

  if (command === "project-user") {
    if (!maybeSkillName) usage();
    projectUserSkillGlobal(maybeSkillName, {
      projectCursor: hasFlag(rest, "--project-cursor"),
    });
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
