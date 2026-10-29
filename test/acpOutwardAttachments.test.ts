import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { stageOutwardAcpAttachments } from "../src/acpServer/attachments.js";

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
});
