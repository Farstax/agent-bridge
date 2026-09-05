import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadInteractiveEnv, resolveInteractiveEnvPath } from "../src/interactiveEnv.js";

describe("interactive env loading", () => {
  it("loads .env.interactive by default without overriding ambient values", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-interactive-env-"));
    try {
      writeFileSync(join(dir, ".env.interactive"), [
        "TELEGRAM_BOT_TOKEN_INTERACTIVE=file-token",
        "BRIDGE_PROJECT_DIR=/from-file",
        "",
      ].join("\n"));
      const env: Record<string, string | undefined> = {
        TELEGRAM_BOT_TOKEN_INTERACTIVE: "ambient-token",
      };

      const result = loadInteractiveEnv(env, dir);

      expect(result).toEqual({ path: join(dir, ".env.interactive"), loaded: true });
      expect(env.TELEGRAM_BOT_TOKEN_INTERACTIVE).toBe("ambient-token");
      expect(env.BRIDGE_PROJECT_DIR).toBe("/from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors BRIDGE_ENV_FILE and leaves a missing file as an offline no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-interactive-env-file-"));
    try {
      const custom = join(dir, "custom.env");
      writeFileSync(custom, "TELEGRAM_ALLOWED_USER_IDS=123\n");
      const env: Record<string, string | undefined> = { BRIDGE_ENV_FILE: custom };

      expect(resolveInteractiveEnvPath(env, dir)).toBe(custom);
      expect(loadInteractiveEnv(env, dir).loaded).toBe(true);
      expect(env.TELEGRAM_ALLOWED_USER_IDS).toBe("123");

      const missingEnv: Record<string, string | undefined> = { BRIDGE_ENV_FILE: join(dir, "missing.env") };
      expect(loadInteractiveEnv(missingEnv, dir)).toEqual({
        path: join(dir, "missing.env"),
        loaded: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
