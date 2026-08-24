export const PROVIDER_IDS = ["codex", "claude", "agy", "grok", "cursor"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderErrorClassification =
  | { readonly kind: "capacity_exhausted"; readonly reason: string }
  | { readonly kind: "auth_required"; readonly reason: string }
  | { readonly kind: "model_unavailable"; readonly reason: string }
  | { readonly kind: "transient"; readonly reason: string }
  | { readonly kind: "fatal"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export interface ProviderCapabilities {
  readonly interactive: boolean;
  readonly fallbackTarget: boolean;
  /** Supports buildCliInvocation's toolMode: "none" (tool-free mode). */
  readonly toolFree: boolean;
}


export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly executable: string;
  readonly versionArgs: readonly string[];
  readonly defaultArgs: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly processWatch?: import("../types.js").CliProcessWatch;
}

/** CLI kind vocabulary used in fallback-chain env vars; "antigravity" maps to provider id "agy". */
export type ChainCliKind = "codex" | "claude" | "antigravity" | "grok" | "cursor";

// Issue #135 Phase 3B — provider runtime invocation/parsing boundary.
// Shared request/result shapes for src/providers/codexRuntime.ts and
// src/providers/claudeRuntime.ts. Deliberately narrower than
// buildCliInvocation()'s full parameter set: no bot/sessionMode/logFile/
// homeDir, since only antigravity uses logFile/homeDir and bot is already
// implied by which runtime module is called.
export interface ProviderInvocationRequest {
  prompt: string;
  sessionId: string | null;
  command: string;
  model: string | null;
  executionMode: "safe" | "trusted";
  outputFormat: "json" | "stream-json" | "streaming-json" | null;
  soulContext: string | null;
  includeResponseContract?: boolean;
  attachments: string[];
  outputDir: string | null;
  effort: import("../effort.js").EffortLevel | null;
  toolMode: "default" | "none";
  /** Keep provider-owned native background/task work inside this CLI turn until terminal completion. */
  nativeCompletion?: boolean;
}

export interface ProviderInvocation {
  command: string;
  args: string[];
  stdin?: string;
  /** Whether this invocation continues or establishes native provider state. */
  nativeSessionMode: "fresh" | "resume";
}

// Issue #135 Phase 3C — Antigravity is the only provider using logFile/
// homeDir (state-dir bootstrap, settings.json model override, conversation
// log scanning), so those two fields extend the shared request only here
// rather than widening ProviderInvocationRequest for every provider.
export interface AntigravityInvocationRequest extends ProviderInvocationRequest {
  logFile: string | null;
  homeDir: string;
}
