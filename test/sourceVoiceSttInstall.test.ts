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
});
