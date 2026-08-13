/**
 * PURPOSE: Job handler for the `ops_check` task type — the bounded,
 * report-only operations Skill fed by the health event ingress boundary
 * (src/health/eventIngress.ts, issue #351). Produces a diagnostic summary
 * from the bounded event payload already captured at receipt time. Never
 * mutates the repository, opens a PR, or runs a coding-agent CLI; mutation
 * stays behind the existing owner-approval path used by sibling handlers
 * (e.g. defectScan.ts's approve → tdd_implementation flow).
 * NEIGHBORS: src/jobExecutor.ts, src/health/eventIngress.ts, src/index-worker.ts
 */
import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";

export function createOpsCheckHandler(): JobHandler {
  return async function opsCheckHandler(
    input: JobHandlerInput,
    _ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const pluginName = typeof input.plugin_name === "string" ? input.plugin_name : "unknown";
    const status = typeof input.status === "string" ? input.status : "unknown";
    const summary = typeof input.summary === "string" ? input.summary : "";

    const report = `ops_check (report-only): plugin '${pluginName}' status=${status}. ${summary}`.trim();

    return {
      summary: report,
      plugin_name: pluginName,
      plugin_status: status,
    };
  };
}
