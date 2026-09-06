import { afterEach, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSkillPackDirectorySha256, installSkillPack } from "../src/skillPacks.js";

const tempDirs: string[] = [];

function temp(label: string): string {
  const path = join(tmpdir(), `agent-bridge-pack-remote-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("does not let a remote curated catalogue select local filesystem Skill content", async () => {
  const home = temp("home");
  const localRepo = temp("content");
  const skillDir = join(localRepo, "skills", "shared");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: shared\ndescription: Local source must not be selectable remotely.\n---\n\n# shared\n",
  );

  const catalogue = {
    schemaVersion: 1,
    catalogueId: "remote-review",
    catalogueVersion: "1.0.0",
    packs: [{
      id: "marketing",
      displayName: "Marketing",
      description: "Remote source review fixture.",
      version: "1.0.0",
      maintainer: "Farstax",
      license: "Apache-2.0",
      categories: ["fixture"],
      capabilityTags: [],
      attribution: [],
      compatibility: { apiVersion: 1, minAgentBridgeVersion: "0.1.0", supportedHosts: ["codex"] },
      dependencies: { requiredLocal: [], optionalLocal: [], externalServices: [], hostedMcps: [], requiredSecrets: [] },
      capabilities: { effects: ["local-read"], approval: "Local read only." },
      tests: [],
      skills: [{
        id: "shared",
        description: "Remote catalogue local-path fixture.",
        content: {
          repository: localRepo,
          revision: "fixture-revision",
          path: "skills/shared",
          sha256: hashSkillPackDirectorySha256(skillDir),
        },
        provenance: { origin: "farstax-authored", modifiedFromUpstream: false, lastReviewed: "2026-09-06" },
        supportedHosts: ["codex"],
        dependencies: { requiredLocal: [], optionalLocal: [], externalServices: [], hostedMcps: [], requiredSecrets: [] },
        capabilities: { effects: ["local-read"], approval: "Local read only." },
        tests: [],
      }],
    }],
  };

  await expect(installSkillPack("marketing", {
    homeDir: home,
    catalogueSource: "https://raw.githubusercontent.com/Farstax/agent-bridge-skills/main/catalogue.json",
    agentBridgeVersion: "0.1.0",
    fetchImpl: async () => new Response(JSON.stringify(catalogue), { status: 200 }),
  })).rejects.toThrow(/local Skill content repository requires a local catalogue/i);
});
