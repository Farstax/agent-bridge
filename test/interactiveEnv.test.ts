import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadInteractiveEnvFile, resolveInteractiveEnvFile } from "../src/interactiveEnv.js";

describe("interactive env loading", () => {
  it("defaults to .env.interactive in the current working directory", () => {
    expect(resolveInteractiveEnvFile({}, "/srv/agent-bridge")).toBe("/srv/agent-bridge/.env.interactive");
  });

  it("honours BRIDGE_ENV_FILE and populates the requested environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-env-"));
    const envPath = join(dir, "custom.env");
    writeFileSync(envPath, "TELEGRAM_ALLOWED_USER_IDS=12345\nBRIDGE_PROJECT_DIR=/srv/example\n", "utf8");
    const target: NodeJS.ProcessEnv = {};
    try {
      const loadedPath = loadInteractiveEnvFile({
        env: { BRIDGE_ENV_FILE: "custom.env" },
        processEnv: target,
        cwd: dir,
      });
      expect(loadedPath).toBe(envPath);
      expect(target.TELEGRAM_ALLOWED_USER_IDS).toBe("12345");
      expect(target.BRIDGE_PROJECT_DIR).toBe("/srv/example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite already-authoritative ambient values", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-env-precedence-"));
    const envPath = join(dir, ".env.interactive");
    writeFileSync(envPath, "BRIDGE_PROJECT_DIR=/from-file\n", "utf8");
    const target: NodeJS.ProcessEnv = { BRIDGE_PROJECT_DIR: "/from-process" };
    try {
      loadInteractiveEnvFile({ env: {}, processEnv: target, cwd: dir });
      expect(target.BRIDGE_PROJECT_DIR).toBe("/from-process");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
