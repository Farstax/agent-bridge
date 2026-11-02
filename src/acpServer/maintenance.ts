/** ACP housekeeping is invoked by the existing host maintenance timer. */
import { realpathSync, statSync } from "node:fs";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { cleanupStaleOutwardAcpAttachments, referencedQueuedAttachmentDirs } from "./attachments.js";
import { OUTWARD_ACP_SURFACE } from "./recovery.js";

const dbPath = process.env.BRIDGE_DB_PATH || process.env.DB_PATH;
const configuredRoot = process.env.BRIDGE_ACP_WORKSPACE_ROOT || process.env.BRIDGE_PROJECT_DIR || process.env.BRIDGE_CURRENT_RELEASE_DIR;
if (!dbPath || !configuredRoot) throw new Error("ACP maintenance requires a configured database and trusted workspace root");
const workspaceRoot = realpathSync(configuredRoot);
if (!statSync(workspaceRoot).isDirectory()) throw new Error("ACP maintenance workspace root must be a directory");
const db = openProductionDb(dbPath, {
  serviceId: "acp:maintenance",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
});
try {
  db.pruneExpiredSessions();
  // Earlier releases cleared these coordination keys by writing NULL, leaving one
  // dead row per Run. A NULL value is already treated as absent, so this is lossless.
  db.raw.prepare("DELETE FROM settings WHERE value IS NULL AND (key LIKE 'outward-cancel:%' OR key LIKE 'outward-queue-%')").run();
  // Each persisted ACP cwd was admitted under its own trusted launch root.
  // A janitor's release-directory root must not hide other clients' projects.
  const workspaces = new Set([workspaceRoot, ...new OutwardAcpSessionRepository(db.raw).listWorkspaces()]);
  // Read every queue reference once, after which unreferenced old snapshots are
  // provably orphaned; a row inserted later cannot own a snapshot this old.
  let referencedQueuedDirs: Set<string> | null = null;
  try {
    referencedQueuedDirs = referencedQueuedAttachmentDirs(
      (db.raw.prepare("SELECT attachments_json AS json FROM pending_messages WHERE surface = ?")
        .all(OUTWARD_ACP_SURFACE) as Array<{ json: string }>).map((row) => row.json));
  } catch (error) {
    // An unreadable queue reference means ownership is unprovable: keep every
    // queued snapshot, but let the unrelated staging sweeps still run.
    console.error("[acp:maintenance] queued attachment references unreadable; keeping all queued snapshots", error);
  }
  for (const workspace of workspaces) {
    try {
      await cleanupStaleOutwardAcpAttachments(workspace, [], Date.now(), referencedQueuedDirs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
} finally {
  db.close();
}
