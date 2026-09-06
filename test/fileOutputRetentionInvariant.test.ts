import { afterEach, describe, expect, it, vi } from "vitest";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanOutputDir,
  cleanupExpiredRetainedOutputDirs,
  prepareOutputDir,
  uploadOutputFiles,
} from "../src/fileOutput.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

const dirs: string[] = [];

async function dirExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => cleanOutputDir(dir).catch(() => {})));
  vi.restoreAllMocks();
});

describe("bounded failed artifact retention", () => {
  it("preserves the original expiry when a retained file fails again", async () => {
    const dir = await prepareOutputDir(91919, "claude", `retry-bound-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    await writeFile(join(dir, "retry.pdf"), "PDF");
    const client = {
      capabilities: TELEGRAM_SURFACE_CAPABILITIES,
      sendPhoto: vi.fn(),
      sendDocument: vi.fn().mockRejectedValue(new Error("still unavailable")),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;

    const first = await uploadOutputFiles(dir, 91919, client);
    const second = await uploadOutputFiles(dir, 91919, client);

    expect(first.status).toBe("partial");
    expect(first.retainedUntil).toBeTruthy();
    expect(second).toMatchObject({ status: "partial", failedFiles: ["retry.pdf"] });
    expect(second.retainedUntil).toBe(first.retainedUntil);
    expect(await dirExists(dir)).toBe(true);
  });

  it("fails closed on malformed durable retention metadata during restart-style cleanup", async () => {
    const dir = await prepareOutputDir(92929, "claude", `invalid-marker-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    await writeFile(join(dir, "retained.pdf"), "PDF");
    await writeFile(join(dir, ".delivery-retained.json"), "not-json");

    await cleanupExpiredRetainedOutputDirs(Date.now());

    expect(await dirExists(dir)).toBe(false);
  });
});
