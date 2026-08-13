import { basename, dirname } from "node:path";
import { rmSync, unlinkSync } from "node:fs";

export function cleanupAttachmentPaths(attachments: string[]): void {
  const uploadDirs = new Set<string>();
  for (const attachment of attachments) {
    try { unlinkSync(attachment); } catch {}
    const parent = dirname(attachment);
    if (basename(parent).startsWith("bridge-uploads-") || basename(parent).startsWith("bridge-continuation-attachments-")) uploadDirs.add(parent);
  }
  for (const dir of uploadDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
