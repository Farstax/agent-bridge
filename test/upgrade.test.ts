import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("upgrade CLI verification", () => {
  it("fails when npm installation fails instead of suppressing the error", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const npm = join(root, "npm");
    writeFileSync(npm, `#!/usr/bin/env bash\nfor arg in "$@"; do if [ "$arg" = install ]; then printf install > "${root}/install-called"; exit 42; fi; done\necho '@scope/pkg@1.0.0'\n`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, "install-called"))).toBe(true);
  });

  it("requires a version after installation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const npm = join(root, "npm");
    writeFileSync(npm, `#!/usr/bin/env bash\nfor arg in "$@"; do if [ "$arg" = install ]; then exit 0; fi; done\nexit 1\n`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
  });
});
