import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("source voice STT install", () => {
  it("converges the OSS-owned STT helper before enabling source-installed services", () => {
    const script = readFileSync(join(process.cwd(), "scripts/install.sh"), "utf8");
    const converge = script.indexOf('sudo /bin/bash "${REPO_DIR}/scripts/install-voice-stt.sh"');
    const enable = script.indexOf("sudo systemctl enable ${UNITS_TO_ENABLE}");
    expect(converge).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(converge);
  });

  it("converges STT after source qualification but before update restarts and normal source starts", () => {
    const script = readFileSync(join(process.cwd(), "scripts/upgrade.sh"), "utf8");
    const tests = script.indexOf('echo "[update] Running tests..."');
    const updateConverge = script.indexOf("\n  converge_voice_stt\n", tests);
    const restart = script.indexOf('echo "[update] Restarting active services..."');
    expect(updateConverge).toBeGreaterThan(tests);
    expect(restart).toBeGreaterThan(updateConverge);

    const normalConverge = script.lastIndexOf("\nconverge_voice_stt\n");
    const enable = script.indexOf("sudo systemctl enable --now ${UNITS_TO_ENABLE}");
    expect(normalConverge).toBeGreaterThan(restart);
    expect(enable).toBeGreaterThan(normalConverge);
  });
});
