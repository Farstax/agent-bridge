import { resolve } from "node:path";
import { openProductionDb, type BridgeDb, type OpenDbOptions } from "./db.js";
import type { ExecutionCapacityConfig } from "./config.js";

/**
 * Opens no new database: positive caps use an already-managed production DB
 * selected by installation configuration.  A separate connection is needed
 * only when this surface's conversation DB is not the shared coordinator.
 */
export function openExecutionCapacityCoordinator(
  config: ExecutionCapacityConfig,
  primaryDbPath: string,
  primaryDb: BridgeDb,
  options: OpenDbOptions,
): BridgeDb | null {
  if (config.maxConcurrentExecutions === 0) return null;
  const coordinatorPath = config.coordinatorDbPath!;
  if (resolve(coordinatorPath) === resolve(primaryDbPath)) return primaryDb;
  return openProductionDb(coordinatorPath, {
    serviceId: `${options.serviceId ?? "bridge"}:execution-capacity`,
    installationId: options.installationId,
    requireInstallationIdentity: options.requireInstallationIdentity,
    // This is a proven managed coordinator, not this service's own state DB.
    // openProductionDb still validates its schema and installation provenance.
  });
}
