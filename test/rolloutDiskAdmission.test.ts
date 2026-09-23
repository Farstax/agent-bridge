import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actions, cleanupRoots, createFixture, runRollout, useMinimalInventory } from "./support/rolloutFixture.js";

afterEach(cleanupRoots);

const evidenceBytes = 16_777_216;
const commit = "a".repeat(40);

function writeTerminal(logDir: string, backupDir: string, stamp: string, phase = "COMPLETE") {
  const name = `${stamp}-${commit}`;
  const directory = join(logDir, name);
  mkdirSync(directory, { recursive: true });
  const ledger = join(directory, "phase-ledger.log");
  writeFileSync(ledger, `phase=${phase} timestamp=2026-01-01T00:00:00Z\n`);
  writeFileSync(`${ledger}.sha256`, execFileSync("sha256sum", [ledger]));
  mkdirSync(join(backupDir, name), { recursive: true });
  writeFileSync(join(backupDir, name, "database"), "backup\n");
  return name;
}

function budget(fixture: ReturnType<typeof createFixture>, extra: { host?: number; reserve?: number } = {}) {
  const reserve = extra.reserve ?? 1_048_576;
  const host = extra.host ?? 0;
  const database = statSync(fixture.dbPaths[0]).size;
  return {
    reserve,
    host,
    database,
    activationOnly: evidenceBytes + reserve + host,
    required: database * 2 + evidenceBytes + host + reserve,
  };
}

describe("rollout disk admission", () => {
  it("refuses before service stop when the transaction does not fit", () => {
    const fixture = useMinimalInventory(createFixture());
    const activeBefore = readFileSync(fixture.stateFile, "utf8");
    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "1",
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: "1048576",
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/insufficient disk for rollout and rollback/);
    expect(output).toMatch(/disk admission available=1 required=/);
    expect(output).not.toMatch(/stopping all services/);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(activeBefore);
    expect(readdirSync(fixture.backupDir)).toEqual([]);
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress"))).toBe(false);
  });

  it("rejects activation headroom that does not also reserve rollback space", () => {
    const fixture = useMinimalInventory(createFixture());
    const numbers = budget(fixture);
    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: String(numbers.activationOnly + numbers.database),
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: String(numbers.reserve),
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(new RegExp(`restore_scratch=${numbers.database}`));
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(readFileSync(fixture.stateFile, "utf8")).toContain("agent-bridge");
  });

  it("includes host-component bytes before containment and keeps the component check", () => {
    const fixture = useMinimalInventory(createFixture());
    const numbers = budget(fixture, { host: 4096 });
    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: String(numbers.required - numbers.host),
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: String(numbers.reserve),
      AGENT_BRIDGE_ROLLOUT_HOST_COMPONENT_BYTES: String(numbers.host),
    });
    const rollout = readFileSync(new URL("../scripts/rollout-agent-bridge.sh", import.meta.url), "utf8");
    const agy = readFileSync(new URL("../scripts/install-agy-acp.sh", import.meta.url), "utf8");

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/host_component=4096/);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(rollout).toContain("--print-required-bytes");
    expect(agy).toContain("insufficient disk space to stage Agy ACP component");
  });

  it("prunes only proven old terminal artifacts and then remeasures free space", () => {
    const fixture = useMinimalInventory(createFixture());
    const kept = [
      writeTerminal(fixture.logDir, fixture.backupDir, "20260103T000000Z"),
      writeTerminal(fixture.logDir, fixture.backupDir, "20260104T000000Z"),
    ];
    const removed = writeTerminal(fixture.logDir, fixture.backupDir, "20260101T000000Z");
    const ambiguous = `20200101T000000Z-${"b".repeat(40)}`;
    mkdirSync(join(fixture.logDir, ambiguous));
    writeFileSync(join(fixture.backupDir, "orphan.sqlite"), "not a rollout set\n");
    const sentinelName = writeTerminal(fixture.logDir, fixture.backupDir, "20260102T000000Z", "CONTAINED");
    const probe = join(fixture.root, "available-bytes");
    writeFileSync(probe, `#!/bin/bash
if [ -d ${JSON.stringify(join(fixture.logDir, removed))} ]; then
  printf '1\\n'
else
  printf '999999999999\\n'
fi
`);
    execFileSync("chmod", ["755", probe]);

    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES_COMMAND: probe,
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: "1048576",
      AGENT_BRIDGE_ROLLOUT_RETENTION_COUNT: "2",
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/rollout retention pruned=1/);
    expect(output.indexOf("rollout retention")).toBeLessThan(output.indexOf("disk admission"));
    expect(output.indexOf("disk admission")).toBeLessThan(output.indexOf("stopping all services"));
    expect(existsSync(join(fixture.logDir, removed))).toBe(false);
    expect(existsSync(join(fixture.backupDir, removed))).toBe(false);
    for (const name of kept) {
      expect(existsSync(join(fixture.logDir, name))).toBe(true);
      expect(existsSync(join(fixture.backupDir, name))).toBe(true);
    }
    expect(existsSync(join(fixture.logDir, ambiguous))).toBe(true);
    expect(existsSync(join(fixture.logDir, sentinelName))).toBe(true);
    expect(readFileSync(join(fixture.backupDir, "orphan.sqlite"), "utf8")).toBe("not a rollout set\n");
    expect(actions(fixture)).toContain("systemctl:stop");
  });

  it("retries a refused rollout once without leaving a backup or sentinel behind", () => {
    const fixture = useMinimalInventory(createFixture());
    const refused = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "1",
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: "1048576",
      AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: "20260923T000000Z",
    });
    expect(refused.status).not.toBe(0);
    expect(readdirSync(fixture.backupDir)).toEqual([]);
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress"))).toBe(false);

    const retried = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "999999999999",
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: "1048576",
      AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: "20260923T000001Z",
    });
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(readdirSync(fixture.backupDir)).toEqual([`20260923T000001Z-${fixture.expectedCommit}`]);
    expect(existsSync(join(fixture.logDir, `20260923T000000Z-${fixture.expectedCommit}`))).toBe(true);
  });
});
