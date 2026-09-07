import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CANONICAL_STT_ROOT = "/opt/agent-bridge/host-components/voice-stt";
const LEGACY_STT_ROOT = "/var/lib/agent-bridge/stt";
const HISTORICAL_RELEASE = "/opt/agent-bridge/releases/04e42a0bd527e60d8acd1472d09ca17316b0b176";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function historicalIngressRoot(env: NodeJS.Dict<string>): string {
  return env.AGENT_BRIDGE_STT_ROOT || LEGACY_STT_ROOT;
}

function historicalReadinessRoot(env: { AGENT_BRIDGE_STT_ROOT?: string }): string {
  return env.AGENT_BRIDGE_STT_ROOT?.trim() || LEGACY_STT_ROOT;
}

function publishSharedRuntimeContract(sharedEnvFile: string, sttRoot: string): void {
  const installer = readFileSync(join(process.cwd(), "scripts/install-voice-stt.sh"), "utf8");
  const match = installer.match(/publish_shared_runtime_contract\(\) \{\n[\s\S]*?\n\}/);
  if (!match) throw new Error("publish_shared_runtime_contract is missing from install-voice-stt.sh");
  execFileSync("bash", ["-c", `
set -euo pipefail
fail() { echo "$*" >&2; exit 1; }
SHARED_ENV_FILE=${JSON.stringify(sharedEnvFile)}
STT_ROOT=${JSON.stringify(sttRoot)}
SHARED_ENV_TMP=""
${match[0]}
publish_shared_runtime_contract
`], { encoding: "utf8" });
}

describe("voice STT rollback compatibility", () => {
  it("lets a historical 04e42a0-shaped runtime keep the isolated STT root through AGENT_BRIDGE_STT_ROOT", () => {
    expect(historicalIngressRoot({})).toBe(LEGACY_STT_ROOT);
    expect(historicalReadinessRoot({})).toBe(LEGACY_STT_ROOT);
    expect(historicalIngressRoot({ AGENT_BRIDGE_STT_ROOT: CANONICAL_STT_ROOT })).toBe(CANONICAL_STT_ROOT);
    expect(historicalReadinessRoot({ AGENT_BRIDGE_STT_ROOT: CANONICAL_STT_ROOT })).toBe(CANONICAL_STT_ROOT);
  });

  it.runIf(existsSync(join(HISTORICAL_RELEASE, "src/voiceIngress.ts")))(
    "keeps the live historical release on the AGENT_BRIDGE_STT_ROOT contract",
    () => {
      const ingress = readFileSync(join(HISTORICAL_RELEASE, "src/voiceIngress.ts"), "utf8");
      const readiness = readFileSync(join(HISTORICAL_RELEASE, "src/voiceRuntimeReadiness.ts"), "utf8");
      expect(ingress).toContain('process.env.AGENT_BRIDGE_STT_ROOT || "/var/lib/agent-bridge/stt"');
      expect(readiness).toContain('env.AGENT_BRIDGE_STT_ROOT?.trim() || "/var/lib/agent-bridge/stt"');
    },
  );

  it("publishes the compatibility env after verification without rewriting unrelated shared settings", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-stt-shared-env-"));
    roots.push(root);
    const shared = join(root, "agent-bridge-shared");
    writeFileSync(shared, "TELEGRAM_ALLOWED_USER_IDS=1\nBRIDGE_EXECUTION_MODE=trusted\nAGENT_BRIDGE_STT_ROOT=/var/lib/agent-bridge/stt\n", { mode: 0o600 });
    chmodSync(shared, 0o600);

    publishSharedRuntimeContract(shared, CANONICAL_STT_ROOT);

    expect(readFileSync(shared, "utf8")).toBe(
      "TELEGRAM_ALLOWED_USER_IDS=1\nBRIDGE_EXECUTION_MODE=trusted\nAGENT_BRIDGE_STT_ROOT=/opt/agent-bridge/host-components/voice-stt\n",
    );
    expect(statSync(shared).mode & 0o777).toBe(0o600);
  });

  it("does not weaken /var/lib/agent-bridge from installer or activation scripts", () => {
    const files = [
      "scripts/install-voice-stt.sh",
      "scripts/release-activate.py",
      "scripts/upgrade.sh",
      "scripts/install.sh",
      "scripts/agent-bridge-install.py",
    ].map((path) => readFileSync(join(process.cwd(), path), "utf8")).join("\n");
    expect(files).not.toMatch(/chmod[^\n]*\/var\/lib\/agent-bridge/);
    expect(files).not.toMatch(/chown[^\n]*\/var\/lib\/agent-bridge[^\n]*stt/);
    expect(files).not.toMatch(/setfacl[^\n]*\/var\/lib\/agent-bridge/);
  });
});
