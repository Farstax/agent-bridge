import type { SensorReport } from "./types.js";

export const SENSOR_CALLBACK_PREFIX = "sensor:";

export function isSensorsCommand(rawText: string, botUsername?: string | null): boolean {
  const command = rawText.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (command === "/sensors") return true;
  if (!botUsername || !command?.startsWith("/sensors@")) return false;
  return command.slice("/sensors@".length) === botUsername.toLowerCase();
}

export function buildSensorsKeyboard(sensors: Array<{ id: string; label: string }>) {
  return {
    inline_keyboard: [
      ...sensors.map((sensor) => [{ text: sensor.label, callback_data: `${SENSOR_CALLBACK_PREFIX}${sensor.id}` }]),
      [{ text: "Run all sensors", callback_data: `${SENSOR_CALLBACK_PREFIX}all` }],
    ],
  };
}

export function parseSensorCallback(value: string): string | null {
  if (!value.startsWith(SENSOR_CALLBACK_PREFIX)) return null;
  const id = value.slice(SENSOR_CALLBACK_PREFIX.length);
  return id && Buffer.byteLength(value, "utf8") < 64 ? id : null;
}

export function formatSensorReport(report: SensorReport): string {
  const mark = (status: SensorReport["status"]) => status === "green" ? "🟢" : status === "amber" ? "🟠" : "🔴";
  const checks = report.checks.map((check) => `${mark(check.status)} ${check.name}: ${check.message}`);
  return [report.label, "", ...checks, "", `Overall: ${report.status[0].toUpperCase() + report.status.slice(1)}`].join("\n");
}

export function formatSensorReports(reports: SensorReport[]): string {
  return reports.map(formatSensorReport).join("\n\n---\n\n");
}
