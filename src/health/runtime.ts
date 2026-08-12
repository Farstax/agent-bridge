import type { BridgeDb } from "../db.js";
import type { BotKind } from "../types.js";
import { HealthBridgeBot } from "./bot.js";
import { parseCadenceSeconds, parseHealthCliConfig } from "./config.js";
import { HealthContextStore } from "./context.js";
import { HealthReportStore } from "./reports.js";
import { ExternalPlugin } from "./plugins/external.js";
import { SelfPlugin } from "./plugins/self.js";
import { ServerPlugin } from "./plugins/server.js";
import { formatAggregateReport, formatReport } from "./reporter.js";
import type { HealthPlugin } from "./types.js";

function defaultHealthCliCommand(bot: BotKind, env: Record<string, string | undefined>): string {
  if (bot === "codex") return env.CODEX_COMMAND || "codex";
  if (bot === "antigravity") return env.ANTIGRAVITY_COMMAND || "agy";
  return env.CLAUDE_COMMAND || "claude";
}

export function createHealthRuntime(options: {
  bridgeDb: BridgeDb;
  dbPath: string;
  env: Record<string, string | undefined>;
  chatId: number;
  sendText: (text: string) => Promise<void>;
}) {
  const parsed = parseHealthCliConfig(options.env);
  const cliBot = parsed.bot;
  const healthBot = new HealthBridgeBot({
    db: options.bridgeDb.raw,
    chatId: options.chatId,
    sessionTtlSeconds: Number(options.env.HEALTH_SESSION_TTL_SECONDS) > 0 ? Number(options.env.HEALTH_SESSION_TTL_SECONDS) : 1800,
    autonomy: (options.env.HEALTH_MONITOR_AUTONOMY as "report" | "suggest") || "report",
    cliBot,
    cliBotConfig: { command: parsed.command ?? defaultHealthCliCommand(cliBot, options.env), modelPreference: parsed.modelPreference },
    _sendText: options.sendText,
  });
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
    cliBot,
    healthBot,
    plugins,
    async runChecks(): Promise<string> {
      const reports = await Promise.all(plugins.map((plugin) => plugin.check()));
      await Promise.all(reports.map((report) => healthBot.handleReport(report, { force: true, silent: true })));
      return reports.map((report) => formatReport(report)).join("\n\n---\n\n") || "✅ All checks passed.";
    },
    statusText(): string {
      const context = new HealthContextStore(options.bridgeDb.raw).getContext();
      const aggregate = new HealthReportStore(options.bridgeDb.raw).getAggregate({
        activePluginNames: plugins.map((plugin) => plugin.name),
        freshnessSeconds: parseCadenceSeconds(options.env) * 2,
      });
      if (aggregate.status === null && !aggregate.evidence.stalePluginNames.length) return "No health data yet. Use /health to run a check.";
      return `${formatAggregateReport(aggregate)}${context?.lastSuggestion ? `\n\n*Last suggestion:*\n\n${context.lastSuggestion}` : ""}`;
    },
  };
}
