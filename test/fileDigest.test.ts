import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256File } from "../src/fileDigest.js";

const MODULE_URL = pathToFileURL(join(process.cwd(), "src/fileDigest.ts")).href;

describe("bounded file SHA-256", () => {
  it("matches a whole-file digest across chunk boundaries and for empty files", () => {
    const root = mkdtempSync(join(tmpdir(), "file-digest-"));
    try {
      const path = join(root, "data.bin");
      const content = Buffer.from(Array.from({ length: 10_007 }, (_, index) => index % 251));
      writeFileSync(path, content);
      const expected = createHash("sha256").update(content).digest("hex");
      expect(sha256File(path)).toBe(expected);
      expect(sha256File(path, 4096)).toBe(expected);
      expect(sha256File(path, 1)).toBe(expected);

      const empty = join(root, "empty.bin");
      writeFileSync(empty, "");
      expect(sha256File(empty)).toBe(createHash("sha256").digest("hex"));
      expect(() => sha256File(path, 0)).toThrow("chunkBytes must be a positive integer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hashes a file larger than its memory budget without buffering it", () => {
    const root = mkdtempSync(join(tmpdir(), "file-digest-large-"));
    try {
      const path = join(root, "large.sqlite");
      const size = 256 * 1024 * 1024;
      writeFileSync(path, "");
      truncateSync(path, size);
      const script = `
        const { sha256File } = await import(${JSON.stringify(MODULE_URL)});
        const before = process.resourceUsage().maxRSS;
        const digest = sha256File(${JSON.stringify(path)});
        const growthKiB = process.resourceUsage().maxRSS - before;
        process.stdout.write(JSON.stringify({ digest, growthKiB }));
      `;
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
      const result = JSON.parse(output) as { digest: string; growthKiB: number };
      const expected = createHash("sha256");
      const zeros = Buffer.alloc(1024 * 1024);
      for (let offset = 0; offset < size; offset += zeros.length) expected.update(zeros);
      expect(result.digest).toBe(expected.digest("hex"));
      // A whole-file read grows peak RSS by the file size (256 MiB).
      expect(result.growthKiB).toBeLessThan(64 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps rollout database evidence on the bounded digest", () => {
    const source = readFileSync(join(process.cwd(), "scripts/rollout-db-impl.ts"), "utf8");
    expect(source).toContain("sha256: sha256File(path)");
    expect(source).not.toMatch(/update\(readFileSync\(/);
  });
});
