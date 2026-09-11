import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const previousQualificationPath = process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousBridgeCurrentReleaseDir = process.env.BRIDGE_CURRENT_RELEASE_DIR;
const previousBridgeProjectDir = process.env.BRIDGE_PROJECT_DIR;
const testRoot = mkdtempSync(join(tmpdir(), "agent-bridge-vitest-"));
const testHome = join(testRoot, "home");

mkdirSync(testHome, { recursive: true, mode: 0o700 });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
delete process.env.BRIDGE_CURRENT_RELEASE_DIR;
delete process.env.BRIDGE_PROJECT_DIR;
process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = join(
  testRoot,
  "provider-qualification.json",
);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterAll(() => {
  restoreEnv("AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH", previousQualificationPath);
  restoreEnv("HOME", previousHome);
  restoreEnv("USERPROFILE", previousUserProfile);
  restoreEnv("BRIDGE_CURRENT_RELEASE_DIR", previousBridgeCurrentReleaseDir);
  restoreEnv("BRIDGE_PROJECT_DIR", previousBridgeProjectDir);
  rmSync(testRoot, { recursive: true, force: true });
});
