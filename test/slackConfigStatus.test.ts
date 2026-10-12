import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackConfigError, loadSlackConfig } from "../src/slackConfig.js";
import { SLACK_STATUS_MAX_AGE_MS, SlackStatusWriter, isSlackStatusCurrent } from "../src/slackStatus.js";

describe("slack configuration (#943)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slack-config-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, content: string) => { const p = join(dir, name); writeFileSync(p, content, { mode: 0o600 }); return p; };

  it("reads token files, trimming trailing newlines", () => {
    const cfg = loadSlackConfig({
      SLACK_BOT_TOKEN_FILE: file("bot", "xoxb-1-secret\n"),
      SLACK_APP_TOKEN_FILE: file("app", "xapp-1-secret\r\n"),
      SLACK_ALLOWED_USER_IDS: "U1ABC, U2DEF,U1ABC",
    });
    expect(cfg).toMatchObject({ botToken: "xoxb-1-secret", appToken: "xapp-1-secret", allowedUserIds: ["U1ABC", "U2DEF"], statusFile: null });
  });

  it("accepts environment tokens", () => {
    expect(loadSlackConfig({ SLACK_BOT_TOKEN: "xoxb-1-a", SLACK_APP_TOKEN: "xapp-1-b", SLACK_ALLOWED_USER_IDS: "U1ABC" }).botToken).toBe("xoxb-1-a");
  });

  it("rejects ambiguous, missing and empty inputs without echoing secrets", () => {
    const ok = { SLACK_APP_TOKEN: "xapp-1-b", SLACK_ALLOWED_USER_IDS: "U1ABC" };
    expect(() => loadSlackConfig({ ...ok, SLACK_BOT_TOKEN: "xoxb-1-TOPSECRET", SLACK_BOT_TOKEN_FILE: file("b", "x") })).toThrow(/both set/);
    try { loadSlackConfig({ ...ok, SLACK_BOT_TOKEN: "xoxb-1-TOPSECRET", SLACK_BOT_TOKEN_FILE: file("b", "x") }); } catch (e) { expect(String(e)).not.toContain("TOPSECRET"); }
    expect(() => loadSlackConfig({ ...ok })).toThrow(/SLACK_BOT_TOKEN_FILE/);
    expect(() => loadSlackConfig({ ...ok, SLACK_BOT_TOKEN_FILE: file("empty", "\n") })).toThrow(/empty/);
    expect(() => loadSlackConfig({ ...ok, SLACK_BOT_TOKEN_FILE: join(dir, "missing") })).toThrow(/not a readable file/);
    expect(() => loadSlackConfig({ ...ok, SLACK_BOT_TOKEN_FILE: dir })).toThrow(SlackConfigError);
  });

  it("is default-deny and validates member IDs", () => {
    const tokens = { SLACK_BOT_TOKEN: "xoxb-1-a", SLACK_APP_TOKEN: "xapp-1-b" };
    expect(() => loadSlackConfig({ ...tokens })).toThrow(/default deny/);
    expect(() => loadSlackConfig({ ...tokens, SLACK_ALLOWED_USER_IDS: " , " })).toThrow(/default deny/);
    expect(() => loadSlackConfig({ ...tokens, SLACK_ALLOWED_USER_IDS: "alice" })).toThrow(/member IDs/);
  });
});

describe("slack status file (#943, schema v1)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slack-status-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes an owner-only, atomically replaced JSON record with no content fields", () => {
    const path = join(dir, "status.json");
    let now = Date.parse("2026-10-12T10:00:00Z");
    const writer = new SlackStatusWriter(path, () => now);
    writer.setIdentity({ appId: "A1", teamId: "T1", botUserId: "UBOT" });
    writer.transition("connected");
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(record).sort()).toEqual(["appId", "botUserId", "errorCode", "generation", "lastConnectedAt", "observedAt", "pid", "schemaVersion", "state", "teamId"]);
    expect(record).toMatchObject({ schemaVersion: 1, pid: process.pid, state: "connected", appId: "A1", teamId: "T1", errorCode: null });
    expect(record.generation).toBe(writer.generation);
    now += 1000;
    writer.transition("reconnecting");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ state: "reconnecting", lastConnectedAt: "2026-10-12T10:00:00.000Z" });
    writer.transition("failed", "app_mismatch");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ state: "failed", errorCode: "app_mismatch" });
  });

  it("applies the 45 second, pid, generation and identity freshness rules", () => {
    const writer = new SlackStatusWriter(null, () => Date.parse("2026-10-12T10:00:00Z"));
    writer.setIdentity({ appId: "A1", teamId: "T1", botUserId: "UBOT" });
    writer.transition("connected");
    const record = writer.snapshot();
    const at = (ms: number) => Date.parse(record.observedAt) + ms;
    const expected = { pid: process.pid, generation: writer.generation, appId: "A1", teamId: "T1" };
    expect(isSlackStatusCurrent(record, expected, at(0))).toBe(true);
    expect(isSlackStatusCurrent(record, expected, at(SLACK_STATUS_MAX_AGE_MS))).toBe(true);
    expect(isSlackStatusCurrent(record, expected, at(SLACK_STATUS_MAX_AGE_MS + 1))).toBe(false);
    expect(isSlackStatusCurrent(record, { ...expected, pid: process.pid + 1 }, at(0))).toBe(false);
    expect(isSlackStatusCurrent(record, { ...expected, generation: "other" }, at(0))).toBe(false);
    expect(isSlackStatusCurrent(record, { ...expected, appId: "A2" }, at(0))).toBe(false);
    expect(isSlackStatusCurrent({ ...record, state: "reconnecting" }, expected, at(0))).toBe(false);
  });

  it("records degradation without refreshing the connection time and clears it on recovery", () => {
    let now = Date.parse("2026-10-12T10:00:00Z");
    const writer = new SlackStatusWriter(null, () => now);
    writer.setIdentity({ appId: "A1", teamId: "T1", botUserId: "UBOT" });
    writer.transition("connected");
    const connectedAt = writer.snapshot().lastConnectedAt;
    now += 60_000;
    writer.transition("connected", "database_unavailable");
    expect(writer.snapshot()).toMatchObject({ state: "connected", errorCode: "database_unavailable", lastConnectedAt: connectedAt });
    expect(isSlackStatusCurrent(writer.snapshot(), { pid: process.pid })).toBe(false);
    writer.clearDegraded();
    expect(writer.snapshot().errorCode).toBeNull();
    expect(isSlackStatusCurrent(writer.snapshot(), { pid: process.pid }, now)).toBe(true);
    writer.transition("failed", "app_mismatch");
    writer.stop("failed");
    expect(writer.snapshot()).toMatchObject({ state: "failed", errorCode: "app_mismatch" });
  });

  it("reports a write failure instead of silently claiming readiness", () => {
    const writer = new SlackStatusWriter(join(dir, "missing-dir", "status.json"));
    writer.transition("connected");
    expect(writer.writeFailed).toBe(true);
    chmodSync(dir, 0o700);
  });
});
