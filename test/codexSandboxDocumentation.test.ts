import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guidance = readFileSync("docs/CODEX-SANDBOX-UBUNTU.md", "utf8");

describe("Codex Ubuntu sandbox guidance", () => {
  it("uses Ubuntu's version-specific bwrap profile and refuses duplicate attachments", () => {
    expect(guidance).toContain("apparmor-profiles");
    expect(guidance).toContain("/usr/share/apparmor/extra-profiles/bwrap-userns-restrict");
    expect(guidance).toContain("/etc/apparmor.d/bwrap-userns-restrict");
    expect(guidance).toContain("Ubuntu 26.04 LTS");
    expect(guidance).toContain("Do not copy the 24.04 extra profile or create a");
    expect(guidance).toContain("Do not install a second profile");
    expect(guidance).toContain("kernel.apparmor_restrict_unprivileged_userns");
    expect(guidance).not.toContain("agent-bridge-codex-bwrap");
    expect(guidance).not.toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  });

  it("chains the 24.04 install behind the collision check", () => {
    expect(guidance).toMatch(/sudo test ! -e \/etc\/apparmor\.d\/bwrap-userns-restrict \\\n\s+&& sudo install/);
  });
});
