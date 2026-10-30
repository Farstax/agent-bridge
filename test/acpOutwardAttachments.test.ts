import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { cleanupStaleOutwardAcpAttachments, stageOutwardAcpAttachments } from "../src/acpServer/attachments.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "bridge-outward-attachments-"));
  roots.push(path);
  return path;
}

describe("outward ACP attachment staging", () => {
  it("stages multiple text, image and PDF blocks in the workspace and removes them after use", async () => {
    const cwd = workspace();
    let paths: string[] = [];
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///client/../report.csv", mimeType: "text/csv", text: "name\nAda\n" } },
      { type: "image", mimeType: "image/png", data: Buffer.from("png bytes").toString("base64"), uri: "file:///photo.png" },
      { type: "resource", resource: { uri: "file:///note.pdf", mimeType: "application/pdf", blob: Buffer.from("pdf bytes").toString("base64") } },
    ] as ContentBlock[], async (files) => {
      paths = files;
      expect(files).toHaveLength(3);
      expect(files.every((path) => path.startsWith(cwd))).toBe(true);
      expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(["name\nAda\n", "png bytes", "pdf bytes"]);
      expect(files.some((path) => path.includes(".."))).toBe(false);
    });
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

  it("rejects unsupported content, oversized payloads and too many files before provider execution", async () => {
    const cwd = workspace();
    const unsupported = [{ type: "resource", resource: { uri: "file:///x.exe", mimeType: "application/octet-stream", text: "x" } }] as ContentBlock[];
    await expect(stageOutwardAcpAttachments(cwd, unsupported, async () => undefined)).rejects.toThrow(/unsupported/);
    const oversized = [{ type: "resource", resource: { uri: "file:///x.txt", mimeType: "text/plain", text: "x".repeat(8 * 1024 * 1024 + 1) } }] as ContentBlock[];
    await expect(stageOutwardAcpAttachments(cwd, oversized, async () => undefined)).rejects.toThrow(/size limit/);
    const many = Array.from({ length: 9 }, (_, i) => ({
      type: "resource", resource: { uri: `file:///f${i}.txt`, mimeType: "text/plain", text: "x" },
    })) as ContentBlock[];
    await expect(stageOutwardAcpAttachments(cwd, many, async () => undefined)).rejects.toThrow(/file limit/);

    let decoded = false;
    const deferredBase64 = {
      length: Math.ceil(8 * 1024 * 1024 / 3) * 4,
      toString() { decoded = true; return Buffer.from("x").toString("base64"); },
    };
    const aggregateOverflow = [
      { type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "a".repeat(8 * 1024 * 1024) } },
      { type: "resource", resource: { uri: "file:///b.txt", mimeType: "text/plain", text: "b".repeat(8 * 1024 * 1024) } },
      { type: "image", mimeType: "image/png", data: deferredBase64 },
    ] as unknown as ContentBlock[];
    await expect(stageOutwardAcpAttachments(cwd, aggregateOverflow, async () => undefined)).rejects.toThrow(/size limit/);
    expect(decoded).toBe(false);
  });

  it("preserves old staging directories while their owning process is active", async () => {
    const cwd = workspace();
    await stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "body" } },
    ] as ContentBlock[], async (files) => {
      const staging = dirname(files[0]!);
      const now = Date.now();
      const old = new Date(now - 25 * 60 * 60 * 1000);
      utimesSync(staging, old, old);
      expect(await cleanupStaleOutwardAcpAttachments(cwd, [], now)).toBe(0);
      expect(readFileSync(files[0]!, "utf8")).toBe("body");
    });
  });

  it("preserves staging while the provider child outlives its owner", async () => {
    const cwd = workspace();
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const runId = `staging-child-${process.pid}`;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore", env: { ...process.env, AGENT_BRIDGE_RUN_ID: runId },
    });
    await once(child, "spawn");
    const staging = join(cwd, ".agent-bridge-attachments-provider-live");
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, ".agent-bridge-staging-owner"), "agent-bridge-outward-attachment-v1\n", { mode: 0o600 });
    writeFileSync(join(staging, ".agent-bridge-staging-pid"), `${dead.pid}\n`, { mode: 0o600 });
    writeFileSync(join(staging, ".agent-bridge-staging-run"), `${runId}\n`, { mode: 0o600 });
    const now = Date.now();
    utimesSync(staging, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
    try {
      expect(await cleanupStaleOutwardAcpAttachments(cwd, [], now)).toBe(0);
      expect(existsSync(staging)).toBe(true);
    } finally { child.kill("SIGKILL"); await once(child, "exit"); }
  });

  it("cleans staged files when the provider operation fails", async () => {
    const cwd = workspace();
    let staged = "";
    await expect(stageOutwardAcpAttachments(cwd, [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "body" } },
    ] as ContentBlock[], async (files) => {
      staged = files[0]!;
      throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    expect(existsSync(staged)).toBe(false);
  });

  it("removes only stale Bridge staging directories after process restart", async () => {
    const cwd = workspace();
    const stale = join(cwd, ".agent-bridge-attachments-stale");
    const nested = join(cwd, "nested-workspace");
    const nestedStale = join(nested, ".agent-bridge-attachments-nested-stale");
    const recent = join(cwd, ".agent-bridge-attachments-recent");
    const unowned = join(cwd, ".agent-bridge-attachments-unowned");
    const linked = join(cwd, ".agent-bridge-attachments-linked");
    const outside = workspace();
    const outsideStale = join(outside, ".agent-bridge-attachments-outside-stale");
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exited.status).toBe(0);
    const deadPid = `${exited.pid}\n`;
    mkdirSync(stale, { mode: 0o700 });
    writeFileSync(join(stale, ".agent-bridge-staging-owner"), "agent-bridge-outward-attachment-v1\n", { mode: 0o600 });
    mkdirSync(nested);
    mkdirSync(nestedStale, { mode: 0o700 });
    writeFileSync(join(nestedStale, ".agent-bridge-staging-owner"), "agent-bridge-outward-attachment-v1\n", { mode: 0o600 });
    writeFileSync(join(stale, ".agent-bridge-staging-pid"), deadPid, { mode: 0o600 });
    writeFileSync(join(nestedStale, ".agent-bridge-staging-pid"), deadPid, { mode: 0o600 });
    writeFileSync(join(stale, ".agent-bridge-staging-run"), "dead-provider-one\n", { mode: 0o600 });
    writeFileSync(join(nestedStale, ".agent-bridge-staging-run"), "dead-provider-two\n", { mode: 0o600 });
    mkdirSync(recent);
    mkdirSync(unowned, { mode: 0o700 });
    mkdirSync(outsideStale, { mode: 0o700 });
    writeFileSync(join(outsideStale, ".agent-bridge-staging-owner"), "agent-bridge-outward-attachment-v1\n", { mode: 0o600 });
    symlinkSync(stale, linked);
    const now = Date.now();
    const old = new Date(now - 25 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(nestedStale, old, old);
    utimesSync(unowned, old, old);
    utimesSync(outsideStale, old, old);

    await expect(cleanupStaleOutwardAcpAttachments(cwd, [nested, outside], now)).resolves.toBe(2);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(nestedStale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(unowned)).toBe(true);
    expect(existsSync(outsideStale)).toBe(true);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });
});
