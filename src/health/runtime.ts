import type { BridgeDb } from "../db.js";
import { parseCadenceSeconds } from "./config.js";
import { HealthReportStore } from "./reports.js";
import { ExternalPlugin } from "./plugins/external.js";
import { SelfPlugin } from "./plugins/self.js";
import { ServerPlugin } from "./plugins/server.js";
import { formatAggregateReport, formatReport } from "./reporter.js";
import type { HealthPlugin, HealthReport } from "./types.js";

export function createHealthRuntime(options: {
  bridgeDb: BridgeDb;
  dbPath: string;
  env: Record<string, string | undefined>;
  chatId: number;
  sendText: (text: string) => Promise<void>;
  onReport?: (report: HealthReport, sendNotification: (text: string) => Promise<void>) => Promise<void>;
}) {
  const reportStore = new HealthReportStore(options.bridgeDb.raw);
  const plugins: HealthPlugin[] = [new SelfPlugin(options.bridgeDb, options.dbPath)];
  if (options.env.HEALTH_SERVER_MONITOR_ENABLED !== "0") plugins.push(new ServerPlugin());
  if (options.env.HEALTH_CONTENT_CRAWLER_ENABLED === "1") {
    const home = options.env.HOME || "";
    plugins.push(new ExternalPlugin({
      name: "content-crawler",
      command: `${home}/content-crawler/venv/bin/python3`,
      args: [options.env.HEALTH_CONTENT_CRAWLER_SCRIPT || `${home}/content-crawler/scripts/health_check.py`],
      timeoutMs: 30_000,
    }));
  }
  return {
    plugins,
    async runChecks(sendNotification = options.sendText): Promise<string> {
      const reports = await Promise.all(plugins.map((plugin) => plugin.check()));
      for (const report of reports) {
        reportStore.saveReport(report);
        await options.onReport?.(report, sendNotification);
      }
      return reports.map((report) => formatReport(report)).join("\n\n---\n\n") || "✅ All checks passed.";
    },
    statusText(): string {
      const aggregate = reportStore.getAggregate({
        activePluginNames: plugins.map((plugin) => plugin.name),
        freshnessSeconds: parseCadenceSeconds(options.env) * 2,
      });
      if (aggregate.status === null && !aggregate.evidence.stalePluginNames.length) return "No health data yet. Use /health to run a check.";
      return formatAggregateReport(aggregate);
    },
  };
}
