import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("upgrade CLI verification", () => {
  it("fails when npm installation fails instead of suppressing the error", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const npm = join(root, "npm");
    const node = join(root, "node");
    writeFileSync(node, "#!/usr/bin/env bash\nif [ \"$1\" = \"-p\" ]; then echo 24.0.0; else exit 0; fi\n", { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash\nif [ "$1" = list ]; then echo '@scope/pkg@1.0.0'; exit 0; fi\nexit 42\n`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm CLI installation failed");
  });

  it("requires a version after installation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const npm = join(root, "npm");
    const node = join(root, "node");
    writeFileSync(node, "#!/usr/bin/env bash\nif [ \"$1\" = \"-p\" ]; then echo 24.0.0; else exit 0; fi\n", { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash\nif [ "$1" = list ]; then exit 1; fi\nexit 0\n`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
  });
});
