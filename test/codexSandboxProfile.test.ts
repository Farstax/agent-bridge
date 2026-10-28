import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const profilePath = "examples/apparmor/agent-bridge-codex-bwrap";
const profile = readFileSync(profilePath, "utf8");
const rules = profile.split("\n").map((line) => line.trim()).filter((line) => !line.startsWith("#") && line !== "");

describe("Codex bwrap AppArmor profile", () => {
  it("attaches only to the bundled bwrap under the release tree", () => {
    const profiles = rules.filter((line) => line.startsWith("profile "));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatch(/^profile agent-bridge-codex-bwrap \/opt\/agent-bridge\/releases\/\*\/node_modules\/@openai\/codex-linux-x64\/vendor\/\*\/codex-resources\/bwrap flags=\(unconfined\) \{$/);
  });

  it("grants user namespaces and nothing else", () => {
    const body = rules.filter((line) => !line.startsWith("profile ") && line !== "}" && !line.startsWith("abi ") && !line.startsWith("include <tunables"));
    expect(body).toEqual(["userns,", "include if exists <local/agent-bridge-codex-bwrap>"]);
    expect(rules.join("\n")).not.toMatch(/capability|network|allow all|ptrace|mount/);
  });

  it("documents the cause and rules out the broad workarounds", () => {
    const doc = readFileSync("docs/CODEX-SANDBOX-UBUNTU.md", "utf8");
    expect(doc).toContain("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    expect(doc).toContain("kernel.apparmor_restrict_unprivileged_userns=1");
    expect(doc).toContain("examples/apparmor/agent-bridge-codex-bwrap");
    expect(doc).toMatch(/do not set\s+`kernel\.apparmor_restrict_unprivileged_userns=0`/);
  });

  it.skipIf(process.getuid?.() !== 0 || spawnSync("apparmor_parser", ["--version"]).status !== 0)("compiles with apparmor_parser", () => {
    expect(() => execFileSync("apparmor_parser", ["-QK", profilePath])).not.toThrow();
    expect(existsSync(profilePath)).toBe(true);
  });
});
