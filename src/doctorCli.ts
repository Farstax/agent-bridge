/**
 * PURPOSE: CLI entry for runtime readiness diagnostics (npm run doctor).
 * NEIGHBORS: src/providers/doctor.ts, src/providers/qualificationStatus.ts
 */

import { loadInteractiveEnv } from "./interactiveEnv.js";
import { runDoctor, formatDoctorReport } from "./providers/doctor.js";
import { formatQualificationSummary } from "./providers/qualificationStatus.js";

loadInteractiveEnv(process.env);

const report = runDoctor();
console.log(formatDoctorReport(report));
console.log(formatQualificationSummary());
process.exit(report.ok ? 0 : 1);
