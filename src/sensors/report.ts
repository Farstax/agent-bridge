import type { SensorCheck, SensorReport, SensorStatus } from "./types.js";

const MAX_CHECKS = 32;
const MAX_NAME_CHARS = 120;
const MAX_LABEL_CHARS = 100;
const MAX_MESSAGE_CHARS = 500;
const MAX_SUMMARY_CHARS = 500;
const MAX_VALUE_CHARS = 200;

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function redactSensorText(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization|credential)[A-Za-z0-9_.-]*\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
}

function safeText(value: unknown, max: number): string {
  return bounded(redactSensorText(typeof value === "string" ? value : String(value ?? "")), max);
}

function safeStatus(value: unknown): SensorStatus {
  return value === "green" || value === "amber" || value === "red" ? value : "red";
}

function normalizeCheck(check: SensorCheck, index: number): SensorCheck {
  const value = typeof check.value === "number"
    ? (Number.isFinite(check.value) ? check.value : undefined)
    : typeof check.value === "string"
      ? safeText(check.value, MAX_VALUE_CHARS)
      : undefined;
  return {
    name: safeText(check.name || `check-${index + 1}`, MAX_NAME_CHARS),
    status: safeStatus(check.status),
    message: safeText(check.message || "No observation message", MAX_MESSAGE_CHARS),
    ...(value === undefined ? {} : { value }),
  };
}

export function normalizeSensorReport(report: SensorReport): SensorReport {
  const checks = Array.isArray(report.checks)
    ? report.checks.slice(0, MAX_CHECKS).map(normalizeCheck)
    : [];
  const status = safeStatus(report.status);
  return {
    sensorId: safeText(report.sensorId, MAX_NAME_CHARS),
    label: safeText(report.label, MAX_LABEL_CHARS),
    status,
    checks,
    summary: safeText(report.summary || `${report.label}: ${status}`, MAX_SUMMARY_CHARS),
    timestamp: typeof report.timestamp === "string" && !Number.isNaN(Date.parse(report.timestamp))
      ? report.timestamp
      : new Date().toISOString(),
  };
}
