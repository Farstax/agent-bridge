import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("install Node.js admission floor", () => {
  it("rejects a vulnerable configured Node binary before installation work", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-install-node-floor-"));
    const node = join(root, "node");
    writeFileSync(node, "#!/usr/bin/env bash\nif [ \"$1\" = \"-p\" ]; then echo 24.22.0; else exit 0; fi\n", { mode: 0o755 });

    const result = spawnSync("bash", ["scripts/install.sh", "--non-interactive"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_BIN: node,
        TELEGRAM_ALLOWED_USER_IDS: "10001",
        TELEGRAM_BOT_TOKEN_CODEX: "fixture-token",
        TELEGRAM_BOT_TOKEN_ANTIGRAVITY: "fixture-token",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node.js 24.22.1+");
    expect(result.stdout).not.toContain("Installing Agent Bridge");
  });
});
