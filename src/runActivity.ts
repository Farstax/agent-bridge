export type RunActivityState = "delegated" | "working" | "reviewing" | "failed" | "interrupted";

/** Safe, provider-neutral transient activity. It must never carry prompts, output, or provider ids. */
export interface RunActivity {
  readonly kind: "subagents";
  readonly state: RunActivityState;
  readonly activeCount: number;
}

/**
 * Existing text progress remains the callable contract. Structured transient
 * activity is an optional side channel on the same reporter so execution
 * plumbing does not need provider-specific presentation branches.
 */
export type ProgressReporter = ((text: string) => void) & {
  activity?: (activity: RunActivity) => void;
};

function boundedCount(count: number): string {
  const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return normalized > 9 ? "9+" : String(normalized);
}

export function runActivityText(activity: RunActivity): string {
  const count = Math.max(0, Math.floor(activity.activeCount));
  switch (activity.state) {
    case "delegated":
      return count > 1
        ? `Delegated work to ${boundedCount(count)} subagents…`
        : "Delegated work to a subagent…";
    case "working":
      return count > 1
        ? `${boundedCount(count)} subagents working…`
        : "1 subagent working…";
    case "reviewing":
      return "Reviewing subagent results…";
    case "failed":
      return count > 0
        ? `A subagent failed; ${boundedCount(count)} still working…`
        : "A subagent failed…";
    case "interrupted":
      return count > 0
        ? `Subagent work interrupted; ${boundedCount(count)} still working…`
        : "Subagent work interrupted…";
  }
}
