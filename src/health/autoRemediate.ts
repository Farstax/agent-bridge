import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { HealthReport } from "./types.js";
import {
  isQualificationCurrent,
  qualificationEvidencePath as defaultQualificationEvidencePath,
  qualifyProviderIfNeeded,
  readQualificationEvidence,
} from "../providers/qualification.js";
import { readInstalledProviderVersions } from "../providers/qualificationStatus.js";
import type { ProviderId } from "../providers/types.js";

export interface AutoRemediateOptions {
  upgradeScript: string;
  sendNotification: (text: string) => Promise<void>;
  qualificationEvidencePath?: string;
  bridgeCommit?: string;
}

interface QualificationOutput {
  provider?: string;
  providerVersion?: string;
  overall?: string;
  ran?: boolean;
  checks?: Array<{ name?: string; status?: string }>;
}

const reportedUnreadableQualificationEvidence = new Set<string>();

function parseQualificationOutput(output: string): QualificationOutput[] {
  const records: QualificationOutput[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as QualificationOutput;
      if (parsed.provider && parsed.overall) records.push(parsed);
    } catch {
      // Upgrade output contains ordinary text as well as machine-readable qualification lines.
    }
  }
  return records;
}

function qualificationProblemMessage(record: QualificationOutput): string {
  const failures = record.checks
    ?.filter((check) => check.status === "fail" || check.status === "not_authenticated")
    .map((check) => check.name)
    .filter(Boolean) ?? [];
  const detail = failures.length > 0 ? ` (${failures.join(", ")})` : "";
  return `⚠️ *CLI qualification ${record.overall}:* ${record.provider} ${record.providerVersion ?? "unknown"}${detail}`;
}

async function qualifyOutOfBandVersionChanges(options: AutoRemediateOptions): Promise<void> {
  const evidencePath = options.qualificationEvidencePath ?? defaultQualificationEvidencePath();
  if (!existsSync(evidencePath)) return;

  let evidence;
  try {
    evidence = readQualificationEvidence(evidencePath);
    reportedUnreadableQualificationEvidence.delete(evidencePath);
  } catch (error) {
    if (!reportedUnreadableQualificationEvidence.has(evidencePath)) {
      reportedUnreadableQualificationEvidence.add(evidencePath);
      await options.sendNotification(
        `⚠️ *CLI qualification evidence unreadable:* ${(error as Error).message.slice(0, 240)}`,
      );
    }
    return;
  }

  const installed = readInstalledProviderVersions();
  for (const [provider, installedVersion] of Object.entries(installed)) {
    if (!installedVersion) continue;
    const providerId = provider as ProviderId;
    const previous = evidence.providers[providerId];
    // Only treat a changed version/contract as an out-of-band drift event once
    // this provider has established qualification evidence. First qualification
    // remains owned by the explicit upgrade/qualification path.
    if (!previous || isQualificationCurrent(previous, providerId, installedVersion)) continue;
    try {
      const result = await qualifyProviderIfNeeded({
        providerId,
        installedVersion,
        evidencePath,
        previousVersion: previous.providerVersion,
        bridgeCommit: options.bridgeCommit,
      });
      if (result.ran && result.record.overall !== "pass") {
        await options.sendNotification(qualificationProblemMessage({ ran: true, ...result.record }));
      }
    } catch (error) {
      await options.sendNotification(
        `⚠️ *CLI qualification failed to run:* ${providerId} ${installedVersion}: ${(error as Error).message.slice(0, 240)}`,
      );
    }
  }
}

export async function autoUpdateClis(
  report: HealthReport,
  options: AutoRemediateOptions,
): Promise<void> {
  if (report.pluginName !== "agent-bridge") return;

  const needsUpdate = report.checks.filter(
    c => c.name.startsWith("cli-update-") && c.status !== "green"
  );
  if (needsUpdate.length === 0) {
    await qualifyOutOfBandVersionChanges(options);
    return;
  }

  try {
    const output = execFileSync("bash", [options.upgradeScript, "--clis-only"], {
      encoding: "utf8",
      // Two providers can each perform a bounded fresh + resume qualification.
      // Keep the outer updater timeout above those per-process bounds while still
      // preventing a wedged upgrade from running indefinitely.
      timeout: 600_000,
    });

    const updated = output
      .split("\n")
      .filter(l => l.startsWith("updated:"))
      .map(l => l.slice("updated:".length).trim());

    if (updated.length > 0) {
      await options.sendNotification(
        `🔄 *CLI auto-updated:*\n${updated.map(u => `• ${u}`).join("\n")}`
      );
    }

    for (const record of parseQualificationOutput(output)) {
      if (record.ran !== false && record.overall !== "pass") {
        await options.sendNotification(qualificationProblemMessage(record));
      }
    }

    // The updater may have acted on package metadata, but the runtime
    // executable is authoritative. Re-observe and qualify that executable
    // before reporting remediation complete.
    await qualifyOutOfBandVersionChanges(options);
  } catch (err) {
    await options.sendNotification(
      `⚠️ *CLI auto-update failed:* ${(err as Error).message.slice(0, 300)}`
    );
  }
}
