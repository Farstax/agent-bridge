/**
 * PURPOSE: Hash files of any size with bounded memory.
 * INPUTS: A regular file path and an optional read chunk size.
 * OUTPUTS: The lowercase hex SHA-256 digest of the file contents.
 * NEIGHBORS: scripts/rollout-db-impl.ts (database evidence identity)
 * LOGIC: Production databases can exceed host RAM (a 1.19 GB interactive
 * database on a 1 GB workspace was OOM-killed by a whole-file read), so read
 * fixed-size chunks synchronously instead of buffering the entire file.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export function sha256File(path: string, chunkBytes = DEFAULT_CHUNK_BYTES): string {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("chunkBytes must be a positive integer");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
