/** ACP housekeeping is invoked by the existing host maintenance timer. */
import { realpathSync, statSync } from "node:fs";
import { openProductionDb } from "../db.js";
import { OutwardAcpSessionRepository } from "../repositories/outwardAcpSessionRepository.js";
import { cleanupStaleOutwardAcpAttachments } from "./attachments.js";

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
  // Each persisted ACP cwd was admitted under its own trusted launch root.
  // A janitor's release-directory root must not hide other clients' projects.
  const workspaces = new Set([workspaceRoot, ...new OutwardAcpSessionRepository(db.raw).listWorkspaces()]);
  for (const workspace of workspaces) {
    try {
      await cleanupStaleOutwardAcpAttachments(workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
} finally {
  db.close();
}
