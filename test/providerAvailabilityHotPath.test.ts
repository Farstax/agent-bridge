import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandExistsOnPath, getAvailableCliKinds } from "../src/interactiveCliAuth.js";

// Issue #1385: availability runs on every Workstream status projection, so it
// must not spawn subprocesses or inspect obsolete harnesses, while staying
// exactly as fresh as before.
describe("Issue #1385: provider availability hot path", () => {
  it("resolves PATH commands in-process like which", () => {
    const root = mkdtempSync(join(tmpdir(), "abp-path-"));
    try {
      writeFileSync(join(root, "plain"), "x"); chmodSync(join(root, "plain"), 0o644);
      const bin = join(root, "tool"); writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
      const path = ["", join(root, "missing"), root].join(delimiter);
      expect(commandExistsOnPath("tool", path)).toBe(true);
      expect(commandExistsOnPath("plain", path)).toBe(false);
      expect(commandExistsOnPath("absent", path)).toBe(false);
      expect(commandExistsOnPath(root, path)).toBe(false);
      expect(commandExistsOnPath(bin, "")).toBe(true);
      expect(commandExistsOnPath("", path)).toBe(false);
      chmodSync(bin, 0o644);
      expect(commandExistsOnPath("tool", path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-checks official CLI executable without guessing keyring state or reading a harness", () => {
    const root = mkdtempSync(join(tmpdir(), "abp-agy-"));
    try {
      const binary = join(root, "agy");
      const login = join(root, ".gemini", "oauth_creds.json");
      writeFileSync(binary, "#!/bin/sh\necho agy\n"); chmodSync(binary, 0o755);
      const available = () => getAvailableCliKinds({
        homeDir: root, env: { AGY_ACP_COMMAND: binary, HOME: root }, failedProviders: new Set(),
        commandExists: (cmd) => cmd === binary && commandExistsOnPath(binary),
      }).has("antigravity");
      // Native Google keyring sessions need not create an OAuth JSON file.
      expect(available()).toBe(true);
      mkdirSync(join(root, ".gemini"));
      writeFileSync(login, "{}\n");
      expect(available()).toBe(true);
      chmodSync(binary, 0o644);
      expect(available()).toBe(false);
      chmodSync(binary, 0o755);
      expect(available()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
