import { spawn } from "node:child_process";
import type { Sensor, SensorReport, SensorStatus } from "./types.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CHECKS = 32;
const MAX_TEXT = 500;

function bounded(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function status(value: unknown): SensorStatus | null {
  return value === "green" || value === "amber" || value === "red" ? value : null;
}

function failure(id: string, label: string, message: string): SensorReport {
  return {
    sensorId: id,
    label,
    status: "red",
    checks: [{ name: "external", status: "red", message: bounded(message) }],
    summary: bounded(message),
    timestamp: new Date().toISOString(),
  };
}

function parseExternalReport(id: string, label: string, raw: string): SensorReport {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return failure(id, label, "Sensor output was not valid JSON");
  }
  if (!value || typeof value !== "object") return failure(id, label, "Sensor output must be a JSON object");
  const record = value as Record<string, unknown>;
  const overall = status(record.status);
  if (!overall || !Array.isArray(record.checks)) return failure(id, label, "Sensor output has an invalid status/checks contract");
  const checks = record.checks.slice(0, MAX_CHECKS).map((item, index) => {
    const check = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const checkStatus = status(check.status) ?? "red";
    const name = bounded(check.name ?? `check-${index + 1}`, 120);
    const message = bounded(check.message ?? "No observation message");
    const value = typeof check.value === "number" || typeof check.value === "string" ? check.value : undefined;
    return { name, status: checkStatus, message, ...(value === undefined ? {} : { value }) };
  });
  return {
    sensorId: id,
    label,
    status: overall,
    checks,
    summary: bounded(record.summary ?? `${label}: ${overall}`),
    timestamp: typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
      ? record.timestamp
      : new Date().toISOString(),
  };
}

export class ExternalSensor implements Sensor {
  constructor(
    readonly id: string,
    readonly label: string,
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly timeoutMs = 30_000,
  ) {}

  async check(): Promise<SensorReport> {
    return await new Promise<SensorReport>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let outputOverflow = false;
      const finish = (report: SensorReport) => {
        if (settled) return;
        settled = true;
        resolve(report);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.command, this.args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
      } catch (error) {
        finish(failure(this.id, this.label, error instanceof Error ? error.message : String(error)));
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        finish(failure(this.id, this.label, `Sensor timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString();
        if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
          outputOverflow = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          return current;
        }
        return next;
      };
      child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => {
        clearTimeout(timer);
        finish(failure(this.id, this.label, error.message));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (outputOverflow) {
          finish(failure(this.id, this.label, "Sensor output exceeded the bounded output limit"));
          return;
        }
        if (code !== 0) {
          finish(failure(this.id, this.label, stderr.trim() || `Sensor exited with code ${code ?? "unknown"}`));
          return;
        }
        finish(parseExternalReport(this.id, this.label, stdout));
      });
    });
  }
}
