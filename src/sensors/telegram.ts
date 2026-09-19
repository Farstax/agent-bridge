import type { SensorReport } from "./types.js";
import { redactSensorText } from "./report.js";

export const SENSOR_CALLBACK_PREFIX = "sensor:";
const MAX_SENSOR_MESSAGE_CHARS = 3900;

function boundedMessage(text: string): string {
  return text.length <= MAX_SENSOR_MESSAGE_CHARS ? text : `${text.slice(0, MAX_SENSOR_MESSAGE_CHARS - 1)}…`;
}

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
  return id && Buffer.byteLength(value, "utf8") <= 64 ? id : null;
}

export function formatSensorReport(report: SensorReport): string {
  const mark = (status: SensorReport["status"]) => status === "green" ? "🟢" : status === "amber" ? "🟠" : "🔴";
  const checks = report.checks.map((check) => `${mark(check.status)} ${check.name}: ${check.message}`);
  return boundedMessage([report.label, "", ...checks, "", `Overall: ${report.status[0].toUpperCase() + report.status.slice(1)}`].join("\n"));
}

export function formatSensorReports(reports: SensorReport[]): string {
  return boundedMessage(reports.map(formatSensorReport).join("\n\n---\n\n"));
}


export interface SensorCallbackRunner {
  list(): Array<{ id: string; label: string }>;
  run(id: string): Promise<SensorReport>;
  runAll(): Promise<SensorReport[]>;
}

export async function handleSensorCallback(input: {
  data: string;
  chatId: number | undefined;
  threadId?: number;
  runner: SensorCallbackRunner;
  acknowledge: (text: string) => Promise<void>;
  send: (text: string, threadId?: number) => Promise<void>;
}): Promise<boolean> {
  const sensorId = parseSensorCallback(input.data);
  if (sensorId === null) return false;
  const known = sensorId === "all" || input.runner.list().some((sensor) => sensor.id === sensorId);
  await input.acknowledge(known ? "Running sensor…" : "Unknown sensor");
  if (!known || input.chatId === undefined) return true;

  setTimeout(() => {
    const result = sensorId === "all"
      ? input.runner.runAll().then(formatSensorReports)
      : input.runner.run(sensorId).then(formatSensorReport);
    void result
      .then((text) => input.send(text, input.threadId))
      .catch((error: unknown) => input.send(
        `Sensor check failed: ${redactSensorText(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
        input.threadId,
      ))
      .catch((error: unknown) => console.error("[interactive] failed to send sensor result", error));
  }, 0);
  return true;
}
