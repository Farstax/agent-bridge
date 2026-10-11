import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { CANDIDATE_PARSERS } from "../src/markdown/index.js";

const SHORT_SAMPLE = `
### Status
1. Service active (\`agent-bridge\`)
2. Health check OK
3. Latency 12ms
`.trim();

const MEDIUM_SAMPLE = `
### Rollout Verification Report

1. **Systemd Services**: Verified \`agent-bridge.service\` is active and running (PID 3446). Memory usage is stable at 68MB.

2. **Database Integrity**: Confirmed schema version 10 with SQLite WAL mode enabled. 0 corrupted pages detected.

3. **Inward ACP Providers**: All 4 providers (Claude, Codex, Agy, Grok) healthy and qualified under current runtime contracts.

4. **Surface Channels**: Telegram polling connected; Discord gateway in state \`READY\` with zero pending updates.

5. **External Connectivity**: Health checks passing with 0 errors across 45ms median roundtrip latency.

| Service | Status | Latency |
| :--- | :---: | ---: |
| SQLite | Active | 1.2ms |
| Claude ACP | Active | 420ms |
| Telegram Bot | Active | 68ms |
`.trim();

const LONG_SAMPLE = [
  "# Comprehensive Multi-Subsystem Operational Audit",
  "",
  "This document details the complete end-to-end audit of all subsystem layers.",
  "",
  "## 1. Systemd Daemons",
  "- \`agent-bridge.service\`: Active (running) since 2026-10-10 12:00:00 UTC",
  "- \`agent-bridge-backup.timer\`: Waiting for next trigger window",
  "- Memory consumption: 84.2 MB / 512 MB ceiling",
  "",
  "## 2. Inward Protocol Clients",
  "1. **Codex Provider**: Native CLI and ACP protocol conformance verified.",
  "2. **Claude Provider**: Version 0.85.1 verified with fresh prompt qualification.",
  "3. **Agy Provider**: Unified tool mediation protocol conforming.",
  "4. **Grok Provider**: Version 1.0.46 authenticated and verified.",
  "",
  "## 3. Detailed Metrics Table",
  "| Component | P50 (ms) | P95 (ms) | Error Rate | Status |",
  "| :--- | ---: | ---: | ---: | :---: |",
  "| DB Query | 0.8 | 2.1 | 0.00% | HEALTHY |",
  "| Turn Ingress | 4.2 | 8.9 | 0.00% | HEALTHY |",
  "| Delivery Dispatch | 18.5 | 32.0 | 0.00% | HEALTHY |",
  "| Fallback Chain | 1.1 | 1.9 | 0.00% | HEALTHY |",
  "",
  "## 4. Diagnostics Log",
  "```json",
  JSON.stringify({
    audit_id: "aud-99281-fx",
    timestamp: 1791720000,
    subsystems_checked: 18,
    failures: 0,
    warnings: [],
    verification_hash: "a9f82b7190d0e6c359d9981a8b92b67f"
  }, null, 2),
  "```",
  "",
  "## 5. Extensive Notes",
  "Detailed commentary regarding memory lifecycle management and garbage collection performance: " + "X".repeat(4000),
  "",
  "End of audit."
].join("\n");

interface BenchmarkResult {
  parserId: string;
  parserName: string;
  sampleType: "short" | "medium" | "long";
  charLength: number;
  iterations: number;
  opsPerSec: number;
  medianMs: number;
  p95Ms: number;
  heapDeltaKb: number;
}

function runBenchmarkForSample(
  parserId: string,
  name: string,
  sampleType: "short" | "medium" | "long",
  sample: string,
  iterations: number
): BenchmarkResult {
  const parser = CANDIDATE_PARSERS[parserId];
  if (!parser) throw new Error(`Unknown parser: ${parserId}`);

  // Warmup
  for (let i = 0; i < 50; i++) {
    parser.parse(sample);
  }

  if (global.gc) global.gc();
  const initialMem = process.memoryUsage().heapUsed;

  const times: number[] = [];
  const startTotal = performance.now();

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    parser.parse(sample);
    const t1 = performance.now();
    times.push(t1 - t0);
  }

  const endTotal = performance.now();
  const finalMem = process.memoryUsage().heapUsed;
  const heapDeltaKb = Math.max(0, Math.round((finalMem - initialMem) / 1024));

  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(times.length / 2)];
  const p95Ms = times[Math.floor(times.length * 0.95)];
  const totalDurationSec = (endTotal - startTotal) / 1000;
  const opsPerSec = Math.round(iterations / totalDurationSec);

  return {
    parserId,
    parserName: name,
    sampleType,
    charLength: sample.length,
    iterations,
    opsPerSec,
    medianMs: Number(medianMs.toFixed(4)),
    p95Ms: Number(p95Ms.toFixed(4)),
    heapDeltaKb,
  };
}

async function main() {
  console.log("===============================================================================");
  console.log("  AGENT BRIDGE MARKDOWN PARSER BENCHMARK (SPIKE)");
  console.log("===============================================================================\n");

  const parsers = [
    { id: "custom", name: "Custom Baseline" },
    { id: "marked", name: "Marked" },
    { id: "markdown-it", name: "markdown-it" },
    { id: "remark", name: "remark-parse + remark-gfm" },
  ];

  const samples = [
    { type: "short" as const, text: SHORT_SAMPLE, iters: 2000 },
    { type: "medium" as const, text: MEDIUM_SAMPLE, iters: 1000 },
    { type: "long" as const, text: LONG_SAMPLE, iters: 500 },
  ];

  const allResults: BenchmarkResult[] = [];

  for (const s of samples) {
    console.log(`--- Sample: ${s.type.toUpperCase()} (${s.text.length} chars, ${s.iters} iterations) ---`);
    for (const p of parsers) {
      const res = runBenchmarkForSample(p.id, p.name, s.type, s.text, s.iters);
      allResults.push(res);
      console.log(
        `  ${res.parserName.padEnd(28)} | Median: ${res.medianMs.toFixed(3)} ms | P95: ${res.p95Ms.toFixed(3)} ms | Ops/sec: ${String(res.opsPerSec).padStart(6)} | Heap: +${res.heapDeltaKb} KB`
      );
    }
    console.log("");
  }

  // Save results to JSON for inclusion in report
  fs.writeFileSync(
    "/home/content-crawler/agent-bridge/scripts/benchmark-results.json",
    JSON.stringify(allResults, null, 2),
    "utf8"
  );
  console.log("Saved raw benchmark results to scripts/benchmark-results.json");
}

main().catch(console.error);
