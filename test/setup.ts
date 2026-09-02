import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const previousQualificationPath = process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
const qualificationDir = mkdtempSync(join(tmpdir(), "agent-bridge-vitest-qualification-"));

process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = join(
  qualificationDir,
  "provider-qualification.json",
);

afterAll(() => {
  if (previousQualificationPath === undefined) {
    delete process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH;
  } else {
    process.env.AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH = previousQualificationPath;
  }
  rmSync(qualificationDir, { recursive: true, force: true });
});
