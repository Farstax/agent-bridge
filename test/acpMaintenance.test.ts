import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";

describe("ACP maintenance owner", () => {
  it("expires old sessions and cleans only safely owned stale artifacts under its trusted root", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-maintenance-"));
    try {
      const workspace = join(root, "workspace");
      const child = join(workspace, "project");
      mkdirSync(child, { recursive: true });
      const database = join(root, "bridge.sqlite");
      const db = openDb(database, { databaseRole: "interactive" });
      new OutwardAcpSessionRepository(db.raw).create({ sessionId: "s", conversationId: "acp:s", cwd: child });
      const identity = { surfaceIdentity: "acp:outward", chatKey: "acp:s" };
      db.setSession(identity, "codex", "expired");
      db.raw.prepare("UPDATE bridge_state SET codex_session_created_at = datetime('now', '-8 days')").run();
      db.close();
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      const staging = join(child, ".agent-bridge-attachments-stale");
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, ".agent-bridge-staging-owner"), "agent-bridge-outward-attachment-v1\n", { mode: 0o600 });
      writeFileSync(join(staging, ".agent-bridge-staging-pid"), `${dead.pid}\n`, { mode: 0o600 });
      writeFileSync(join(staging, ".agent-bridge-staging-run"), "dead-maintenance-provider\n", { mode: 0o600 });
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(staging, old, old);
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/acpServer/maintenance.ts"], {
        cwd: process.cwd(), env: { ...process.env, BRIDGE_DB_PATH: database, BRIDGE_ACP_WORKSPACE_ROOT: workspace, NODE_ENV: "test", AGENT_BRIDGE_INSTALLATION_ID: "" }, encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(existsSync(staging)).toBe(false);
      const check = openDb(database, { databaseRole: "interactive", deferSessionExpiry: true });
      try {
        expect(check.raw.prepare("SELECT codex_session_id FROM bridge_state").get()).toEqual({ codex_session_id: null });
      } finally { check.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
