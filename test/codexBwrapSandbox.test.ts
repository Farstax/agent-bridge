import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

const requireSystemProfile = process.env.AB_REQUIRE_SYSTEM_BWRAP_PROFILE === "1";
const enabled = process.platform === "linux" && requireSystemProfile;

describe("Ubuntu system bubblewrap sandbox", () => {
  it.skipIf(!enabled)("keeps filesystem and network restrictions with the distro profile", async () => {
    if (process.getuid?.() === 0) throw new Error("run this qualification as a non-root user");
    const restriction = execFileSync("sysctl", ["-n", "kernel.apparmor_restrict_unprivileged_userns"], { encoding: "utf8" }).trim();
    expect(restriction).toBe("1");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;

    try {
      const result = spawnSync("/usr/bin/bwrap", [
        "--unshare-user",
        "--unshare-net",
        "--ro-bind", "/", "/",
        "--",
        "/bin/sh", "-c",
        `probe=/tmp/agent-bridge-sandbox-probe-$$; if touch "$probe"; then rm -f "$probe"; exit 31; fi; python3 -c "import socket; s=socket.socket(); s.settimeout(1); r=s.connect_ex(('127.0.0.1', ${port})); s.close(); raise SystemExit(0 if r != 0 else 32)"; cat /proc/self/attr/current`,
      ], { encoding: "utf8", timeout: 10_000 });

      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("Read-only file system");
      expect(result.stdout).toContain("unpriv_bwrap");
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
