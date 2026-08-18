import type { ProviderId } from "./providers/types.js";

export interface AdvisorTarget { provider: ProviderId; model: string }

export interface AdvisorConfig {
  enabled: boolean;
  /** Allowed frontier targets. One independent target is selected per invocation; this is not a fallback chain. */
  chain: AdvisorTarget[];
  maxCallsPerTurn: number;
  maxCallsPerTask: number;
  timeoutMs: number;
  contextMaxChars: number;
  outputMaxChars: number;
}
