import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadTelegramAttachment } from "../src/fileDownload.js";
import type { TelegramMessage } from "../src/types.js";

function makeClient(overrides: Partial<{ getFilePath: any; downloadFile: any }> = {}) {
  return {
    getFilePath: overrides.getFilePath ?? vi.fn().mockResolvedValue("photos/file_0.jpg"),
    downloadFile: overrides.downloadFile ?? vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("downloadTelegramAttachment", () => {
  it("returns null for text-only message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    try {
      const msg: TelegramMessage = { message_id: 1, chat: { id: 1, type: "private" }, text: "hello" };
      const result = await downloadTelegramAttachment(makeClient(), msg, dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("picks largest photo (last entry), calls getFilePath + downloadFile, returns localPath + mimeType", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    try {
      const getFilePath = vi.fn().mockResolvedValue("photos/file_0.jpg");
      const downloadFile = vi.fn().mockResolvedValue(undefined);
      const client = makeClient({ getFilePath, downloadFile });

      const msg: TelegramMessage = {
        message_id: 1,
        chat: { id: 42, type: "private" },
        photo: [
          { file_id: "small_id", file_unique_id: "s", width: 100, height: 100, file_size: 1000 },
          { file_id: "large_id", file_unique_id: "l", width: 800, height: 600, file_size: 50000 },
        ],
      };

      const result = await downloadTelegramAttachment(client, msg, dir);

      expect(getFilePath).toHaveBeenCalledWith("large_id");
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe("image/jpeg");
      expect(result!.localPath).toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles document message, uses file_name and mime_type from document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    try {
      const getFilePath = vi.fn().mockResolvedValue("documents/file_42.pdf");
      const downloadFile = vi.fn().mockResolvedValue(undefined);
      const client = makeClient({ getFilePath, downloadFile });

      const msg: TelegramMessage = {
        message_id: 2,
        chat: { id: 42, type: "private" },
        document: {
          file_id: "doc_id",
          file_unique_id: "d",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 12000,
        },
      };

      const result = await downloadTelegramAttachment(client, msg, dir);

      expect(getFilePath).toHaveBeenCalledWith("doc_id");
      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe("application/pdf");
      expect(result!.localPath).toContain("report.pdf");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null if photo file_size exceeds 20 MB without calling the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    try {
      const getFilePath = vi.fn();
      const client = makeClient({ getFilePath });

      const msg: TelegramMessage = {
        message_id: 3,
        chat: { id: 1, type: "private" },
        photo: [
          { file_id: "huge_id", file_unique_id: "h", width: 4000, height: 3000, file_size: 21 * 1024 * 1024 },
        ],
      };

      const result = await downloadTelegramAttachment(client, msg, dir);
      expect(result).toBeNull();
      expect(getFilePath).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null (does not throw) if downloadFile rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    try {
      const downloadFile = vi.fn().mockRejectedValue(new Error("network error"));
      const client = makeClient({ downloadFile });

      const msg: TelegramMessage = {
        message_id: 4,
        chat: { id: 1, type: "private" },
        photo: [{ file_id: "some_id", file_unique_id: "x", width: 100, height: 100 }],
      };

      const result = await downloadTelegramAttachment(client, msg, dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to extension-based mimeType when document has no mime_type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    try {
      const client = makeClient();

      const msg: TelegramMessage = {
        message_id: 5,
        chat: { id: 1, type: "private" },
        document: {
          file_id: "doc_id",
          file_unique_id: "d",
          file_name: "archive.zip",
        },
      };

      const result = await downloadTelegramAttachment(client, msg, dir);
      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe("application/zip");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
