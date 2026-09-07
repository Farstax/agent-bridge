import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CANONICAL_STT_ROOT = "/opt/agent-bridge/host-components/voice-stt";
const LEGACY_STT_ROOT = "/var/lib/agent-bridge/stt";

function repo(path: string): string {
  return join(process.cwd(), path);
}

function text(path: string): string {
  return readFileSync(repo(path), "utf8");
}

describe("issue #725 voice STT protected boundary", () => {
  it("uses one isolated canonical root across install, runtime, readiness and rollback contracts", () => {
    for (const path of [
      ".env.shared.example",
      "scripts/install-voice-stt.sh",
      "scripts/release-activate.py",
      "scripts/upgrade.sh",
      "src/voiceIngress.ts",
      "src/voiceRuntimeReadiness.ts",
    ]) {
      expect(text(path), path).toContain(CANONICAL_STT_ROOT);
    }

    for (const path of [
      "scripts/install-voice-stt.sh",
      "src/voiceIngress.ts",
      "src/voiceRuntimeReadiness.ts",
    ]) {
      expect(text(path), path).not.toContain(LEGACY_STT_ROOT);
    }
  });

  it("does not relax the protected /var/lib/agent-bridge state root", () => {
    const implementation = [
      text("scripts/install-voice-stt.sh"),
      text("scripts/release-activate.py"),
      text("scripts/upgrade.sh"),
    ].join("\n");

    expect(implementation).not.toMatch(/chmod[^\n]*\/var\/lib\/agent-bridge/);
    expect(implementation).not.toMatch(/chown[^\n]*\/var\/lib\/agent-bridge/);
    expect(implementation).not.toMatch(/chgrp[^\n]*\/var\/lib\/agent-bridge/);
    expect(implementation).not.toMatch(/setfacl[^\n]*\/var\/lib\/agent-bridge/);
  });

  it("keeps the changed host lifecycle scripts syntactically valid", () => {
    execFileSync("bash", ["-n", repo("scripts/install-voice-stt.sh")]);
    execFileSync("bash", ["-n", repo("scripts/upgrade.sh")]);
    execFileSync("python3", [
      "-c",
      "import pathlib,sys; p=pathlib.Path(sys.argv[1]); compile(p.read_text(), str(p), 'exec')",
      repo("scripts/release-activate.py"),
    ]);
  });
});
