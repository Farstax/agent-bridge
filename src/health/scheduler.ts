import type { HealthPlugin, HealthConfig, HealthReport } from "./types.js";
import { formatReport } from "./reporter.js";

export class HealthScheduler {
  private plugins: HealthPlugin[];
  private config: HealthConfig;
  private sendReport: (text: string) => Promise<void>;
  private onRawReport?: (report: HealthReport) => Promise<void>;
  private timers: NodeJS.Timeout[] = [];
  private inFlight = new Set<string>();

  constructor(options: {
    plugins: HealthPlugin[];
    config: HealthConfig;
    sendReport: (text: string) => Promise<void>;
    onRawReport?: (report: HealthReport) => Promise<void>;
  }) {
    this.plugins = options.plugins;
    this.config = options.config;
    this.sendReport = options.sendReport;
    this.onRawReport = options.onRawReport;
  }

  start(): void {
    if (!this.config.enabled) return;
    for (const plugin of this.plugins) {
      const timer = setInterval(() => {
        this.runPlugin(plugin).catch(err =>
          console.error(`[health] plugin ${plugin.name} error`, err)
        );
      }, this.config.cadenceSeconds * 1000);
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  async runPlugin(plugin: HealthPlugin): Promise<void> {
    if (this.inFlight.has(plugin.name)) {
      console.warn(`[health] plugin ${plugin.name} run skipped: previous run still in flight`);
      return;
    }
    this.inFlight.add(plugin.name);
    try {
      const report = await plugin.check();

      if (this.onRawReport) {
        await this.onRawReport(report);
      }

      if (!this.config.silenceOnGreen || report.status !== "green") {
        await this.sendReport(formatReport(report));
      }

    } finally {
      this.inFlight.delete(plugin.name);
    }
  }
}
