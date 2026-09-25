import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const installerSource = resolve(process.cwd(), "scripts", "install-cursor-acp.sh");
const cursorVersion = "2026.09.23-86fc751";
const cursorArchiveSha = "740dd9d6eb5aec36ca90eaedf9fd5e2c489cd674d69b5147b3c2670f02d9776d";

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

describe("Cursor ACP installer", () => {
  it("installs the complete dist-package runtime required by the Cursor launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-cursor-installer-"));
    const releaseRoot = join(root, "release");
    const runtimeHome = join(root, "runtime-home");
    const archiveRoot = join(root, "archive", "dist-package");
    const commandRoot = join(root, "bin");
    mkdirSync(runtimeHome);
    mkdirSync(archiveRoot, { recursive: true });
    mkdirSync(commandRoot);
    mkdirSync(join(releaseRoot, "scripts"), { recursive: true });
    mkdirSync(join(releaseRoot, "dist", "providers"), { recursive: true });
    copyFileSync(installerSource, join(releaseRoot, "scripts", "install-cursor-acp.sh"));
    writeFileSync(join(releaseRoot, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(releaseRoot, "dist", "providers", "acpRegistry.js"), `
export function getLockedAcpRegistryEntry() {
  return { version: "${cursorVersion}", distribution: { binary: {
    "linux-x86_64": { archive: "https://example.invalid/cursor.tar.gz", sha256: "${cursorArchiveSha}", cmd: "./dist-package/cursor-agent" }
  } } };
}
`);

    executable(join(archiveRoot, "cursor-agent"), `#!/bin/sh\nexec "$(dirname "$0")/node" "$@"\n`);
    executable(join(archiveRoot, "node"), `#!/bin/sh\nprintf '%s\\n' '${cursorVersion}'\n`);
    const archive = join(root, "cursor-agent.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", join(root, "archive"), "dist-package"]);

    executable(join(commandRoot, "curl"), `#!/bin/sh\nset -eu\nif [ "$1" = --fail ] && [ "$5" = --head ]; then printf 'content-length: 1\\n'; exit 0; fi\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then cp "$CURSOR_FIXTURE_ARCHIVE" "$2"; exit 0; fi; shift; done\nexit 2\n`);
    executable(join(commandRoot, "sha256sum"), `#!/bin/sh\nprintf '%s  %s\\n' '${cursorArchiveSha}' "$1"\n`);

    execFileSync("bash", [join(releaseRoot, "scripts", "install-cursor-acp.sh")], {
      env: {
        ...process.env,
        AGENT_BRIDGE_CURSOR_ACP_USER: process.env.USER ?? "content-crawler",
        AGENT_BRIDGE_HOST_COMPONENT_PHASE: "prepare",
        CURSOR_FIXTURE_ARCHIVE: archive,
        HOME: runtimeHome,
        PATH: `${commandRoot}:${process.env.PATH}`,
      },
      stdio: "pipe",
    });

    const installed = join(runtimeHome, ".local", "share", "agent-bridge", "cursor-acp", "versions", cursorVersion, "dist-package");
    expect(readFileSync(join(installed, "node"), "utf8")).toContain(cursorVersion);
    expect(execFileSync(join(installed, "cursor-agent"), ["--version"], { encoding: "utf8" }).trim()).toBe(cursorVersion);
  });
});
