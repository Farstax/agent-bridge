import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareOutputDir,
  collectOutputFiles,
  cleanOutputDir,
  cleanupExpiredRetainedOutputDirs,
  uploadOutputFiles,
} from "../src/fileOutput.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

async function dirExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe("prepareOutputDir", () => {
  it("uses a unique run-scoped directory so concurrent runs cannot wipe each other", async () => {
    const first = await prepareOutputDir("100:7", "claude", "run-a");
    await writeFile(join(first, "first.txt"), "keep");
    const second = await prepareOutputDir("100:7", "claude", "run-b");
    try {
      expect(first).not.toBe(second);
      expect(await readdir(first)).toEqual(["first.txt"]);
    } finally {
      await cleanOutputDir(first);
      await cleanOutputDir(second);
    }
  });

  it("creates /tmp/bridge-out/<kind>-<chatId>/ and returns the path", async () => {
    const dir = await prepareOutputDir(99999, "claude");
    try {
      expect(dir).toBe("/tmp/bridge-out/claude-99999");
      expect(await dirExists(dir)).toBe(true);
    } finally {
      await cleanOutputDir(dir);
    }
  });

  it("different bot kinds get different directories for the same chatId", async () => {
    const claudeDir = await prepareOutputDir(77777, "claude");
    const codexDir = await prepareOutputDir(77777, "codex");
    try {
      expect(claudeDir).not.toBe(codexDir);
      expect(claudeDir).toBe("/tmp/bridge-out/claude-77777");
      expect(codexDir).toBe("/tmp/bridge-out/codex-77777");
    } finally {
      await cleanOutputDir(claudeDir);
      await cleanOutputDir(codexDir);
    }
  });

  it("wipes existing contents on second call (clean-on-prepare)", async () => {
    const dir = await prepareOutputDir(88888, "antigravity");
    await writeFile(join(dir, "stale.jpg"), "x");
    const dir2 = await prepareOutputDir(88888, "antigravity");
    expect(dir2).toBe(dir);
    const remaining = await readdir(dir);
    expect(remaining).toHaveLength(0);
    await cleanOutputDir(dir);
  });
});

describe("collectOutputFiles", () => {
  it("returns absolute paths of all files in outDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-out-"));
    await writeFile(join(dir, "a.png"), "data1");
    await writeFile(join(dir, "b.txt"), "data2");
    const files = await collectOutputFiles(dir);
    expect(files.sort()).toEqual([join(dir, "a.png"), join(dir, "b.txt")].sort());
  });

  it("returns [] for empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-empty-"));
    const files = await collectOutputFiles(dir);
    expect(files).toEqual([]);
    await cleanOutputDir(dir);
  });

  it("returns [] for non-existent directory", async () => {
    const files = await collectOutputFiles("/tmp/does-not-exist-bridge-xyz");
    expect(files).toEqual([]);
  });
});

describe("cleanOutputDir", () => {
  it("removes all files and the directory itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-clean-"));
    await writeFile(join(dir, "file.txt"), "x");
    await cleanOutputDir(dir);
    expect(await dirExists(dir)).toBe(false);
  });
});

describe("uploadOutputFiles", () => {
  it("calls sendPhoto for .png/.jpg files and sendDocument for others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-upload-"));
    await writeFile(join(dir, "chart.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(dir, "photo.jpg"), Buffer.from([255, 216, 255]));
    await writeFile(join(dir, "report.pdf"), "PDF");

    const sendPhoto = vi.fn().mockResolvedValue(undefined);
    const sendDocument = vi.fn().mockResolvedValue(undefined);
    const client = { capabilities: TELEGRAM_SURFACE_CAPABILITIES, sendPhoto, sendDocument } as any;

    const result = await uploadOutputFiles(dir, 42, client);

    expect(result.status).toBe("complete");
    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(sendDocument).toHaveBeenCalledTimes(1);
    const remaining = await readdir(dir).catch(() => []);
    expect(remaining.filter((f) => !f.startsWith("."))).toHaveLength(0);
    expect(await dirExists(dir)).toBe(false);
  });

  it("passes thread options through to uploaded files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-upload-thread-"));
    const png = join(dir, "chart.png");
    const pdf = join(dir, "report.pdf");
    await writeFile(png, "PNG");
    await writeFile(pdf, "PDF");

    const sendPhoto = vi.fn().mockResolvedValue(undefined);
    const sendDocument = vi.fn().mockResolvedValue(undefined);
    const client = { capabilities: TELEGRAM_SURFACE_CAPABILITIES, sendPhoto, sendDocument } as any;

    await uploadOutputFiles(dir, 42, client, { message_thread_id: 99 });

    expect(sendPhoto).toHaveBeenCalledWith(42, png, undefined, { message_thread_id: 99 });
    expect(sendDocument).toHaveBeenCalledWith(42, pdf, undefined, { message_thread_id: 99 });
  });

  it("retains only failed files, continues mixed delivery, and surfaces partial delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-upload-err-"));
    const failedPath = join(dir, "a.png");
    const deliveredPath = join(dir, "b.png");
    await writeFile(failedPath, "x");
    await writeFile(deliveredPath, "y");

    const sendPhoto = vi.fn().mockImplementation(async (_chatId, filePath: string) => {
      if (filePath === failedPath) throw new Error("upload failed");
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const client = {
      capabilities: TELEGRAM_SURFACE_CAPABILITIES,
      sendPhoto,
      sendDocument: vi.fn(),
      sendMessage,
    } as any;

    const result = await uploadOutputFiles(dir, 1, client);

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "partial", failedFiles: ["a.png"], uploadedFiles: ["b.png"] });
    expect(result.retainedUntil).toBeTruthy();
    expect((await readdir(dir)).sort()).toEqual([".delivery-retained.json", "a.png"]);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 1,
      text: expect.stringContaining("1 generated file could not be delivered"),
    }));
  });

  it("retries only retained failures and removes the directory after retry success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-upload-retry-"));
    const filePath = join(dir, "retry.png");
    await writeFile(filePath, "x");
    const sendPhoto = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const client = {
      capabilities: TELEGRAM_SURFACE_CAPABILITIES,
      sendPhoto,
      sendDocument: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;

    const first = await uploadOutputFiles(dir, 1, client);
    expect(first.status).toBe("partial");
    expect(await dirExists(dir)).toBe(true);

    const second = await uploadOutputFiles(dir, 1, client);
    expect(second).toMatchObject({ status: "complete", uploadedFiles: ["retry.png"], failedFiles: [] });
    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(await dirExists(dir)).toBe(false);
  });

  it("expires retained failures using the durable marker without sweeping unrelated directories", async () => {
    const dir = await prepareOutputDir(90909, "claude", `expiry-${Date.now()}`);
    await writeFile(join(dir, "retained.pdf"), "x");
    const client = {
      capabilities: TELEGRAM_SURFACE_CAPABILITIES,
      sendPhoto: vi.fn(),
      sendDocument: vi.fn().mockRejectedValue(new Error("temporary failure")),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await uploadOutputFiles(dir, 90909, client);
    expect(result.status).toBe("partial");
    expect(await dirExists(dir)).toBe(true);

    await cleanupExpiredRetainedOutputDirs(Date.parse(result.retainedUntil!) + 1);
    expect(await dirExists(dir)).toBe(false);
  });

  it("does not start another upload once publication is fenced and removes stale files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-upload-fenced-"));
    await writeFile(join(dir, "a.png"), "x");
    await writeFile(join(dir, "b.png"), "y");
    let canPublish = true;
    const sendPhoto = vi.fn().mockImplementation(async () => { canPublish = false; });
    const client = { capabilities: TELEGRAM_SURFACE_CAPABILITIES, sendPhoto, sendDocument: vi.fn() } as any;

    const result = await uploadOutputFiles(dir, 1, client, undefined, () => canPublish);

    expect(result.status).toBe("cancelled");
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(await dirExists(dir)).toBe(false);
  });

  it("cleans generated files when the surface cannot publish attachments", async () => {
    const dir = await prepareOutputDir(77777, "claude");
    await writeFile(join(dir, "unsupported.txt"), "x");
    const client = { sendPhoto: vi.fn(), sendDocument: vi.fn() } as any;
    const result = await uploadOutputFiles(dir, 77777, client);
    expect(result).toMatchObject({ status: "unsupported", failedFiles: ["unsupported.txt"] });
    expect(await dirExists(dir)).toBe(false);
  });

  it("calls cleanOutputDir after all uploads even on empty dir", async () => {
    const dir = await prepareOutputDir(77778, "claude");
    const client = { sendPhoto: vi.fn(), sendDocument: vi.fn() } as any;
    await uploadOutputFiles(dir, 77778, client);
    expect(await dirExists(dir)).toBe(false);
  });
});
