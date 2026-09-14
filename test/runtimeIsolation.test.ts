import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downloadTelegramAttachment } from "../src/fileDownload.js";
import { prepareOutputDir, cleanOutputDir } from "../src/fileOutput.js";
import type { TelegramMessage } from "../src/types.js";

function permissionBits(mode: number): number {
  return mode & 0o777;
}

describe("runtime isolation", () => {
  it("creates run output directories with owner-only permissions", async () => {
    const dir = await prepareOutputDir(`permissions-${Date.now()}`, "claude", "run");
    try {
      expect(permissionBits((await stat(dir)).mode)).toBe(0o700);
    } finally {
      await cleanOutputDir(dir);
    }
  });

  it("creates attachment directories with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-attachment-permissions-"));
    const dest = join(root, "incoming");
    await mkdir(dest, { mode: 0o777 });
    await chmod(dest, 0o777);
    const message: TelegramMessage = {
      message_id: 1,
      chat: { id: 1, type: "private" },
      text: "no attachment",
    };
    try {
      await downloadTelegramAttachment({} as never, message, dest);
      expect(permissionBits((await stat(dest)).mode)).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
