import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanOutputDir, prepareOutputDir } from "../src/fileOutput.js";
import { listDeskArtifacts, readDeskArtifact, retainDeskArtifacts } from "../src/acpServer/artifacts.js";

describe("outward ACP generated file handoff", () => {
  it("retains SVG and Office files, reads exact bytes and isolates Workstreams", async () => {
    const conversation = `acp:${randomUUID()}`;
    const runId = randomUUID();
    const dir = await prepareOutputDir(conversation, "codex", runId);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    const document = Buffer.from("office test fixture");
    try {
      await writeFile(join(dir, "cat.svg"), svg);
      await writeFile(join(dir, "report.xlsx"), document);
      const saved = await retainDeskArtifacts(dir, conversation, runId, 2);
      expect(saved).toEqual({ retained: 2, discarded: 0 });
      const files = await listDeskArtifacts(conversation);
      expect(files.map((item) => item.name)).toEqual(["cat.svg", "report.xlsx"]);
      expect(files.every((item) => item.turnIndex === 2 && item.runId === runId)).toBe(true);
      expect((await readDeskArtifact(conversation, files[0]!.id))).toMatchObject({
        status: "found", base64: svg.toString("base64"),
      });
      expect((await readDeskArtifact(conversation, files[1]!.id))).toMatchObject({
        status: "found", base64: document.toString("base64"),
      });
      expect(await readDeskArtifact(`acp:${randomUUID()}`, files[0]!.id)).toEqual({ status: "not_found" });
      expect(await readDeskArtifact(conversation, randomUUID())).toEqual({ status: "not_found" });
      expect((await listDeskArtifacts(conversation)).map((item) => item.id)).toEqual(files.map((item) => item.id));
    } finally { await cleanOutputDir(dir); }
  });

  it("rejects symlinks, unsupported file types and oversized output without exposing bytes", async () => {
    const conversation = `acp:${randomUUID()}`;
    const dir = await prepareOutputDir(conversation, "claude", randomUUID());
    try {
      await symlink("/etc/passwd", join(dir, "private.pdf"));
      await writeFile(join(dir, "unsafe.exe"), "not allowed");
      await writeFile(join(dir, "too-large.pdf"), Buffer.alloc(8 * 1024 * 1024 + 1));
      const saved = await retainDeskArtifacts(dir, conversation, randomUUID(), 0);
      expect(saved).toEqual({ retained: 0, discarded: 3 });
      expect(await listDeskArtifacts(conversation)).toEqual([]);
    } finally { await cleanOutputDir(dir); }
  });
});
