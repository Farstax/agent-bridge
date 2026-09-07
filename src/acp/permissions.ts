import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface AcpPermissionContext {
  readonly executionMode: "safe" | "trusted";
  readonly abortRequested: boolean;
}

function optionOfKind(options: readonly PermissionOption[], kind: PermissionOption["kind"]): PermissionOption | undefined {
  return options.find((option) => option.kind === kind);
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

/**
 * Map ACP permission requests onto existing Bridge execution authority.
 * Bridge remains the policy owner; the agent only proposes options.
 */
export function mapAcpPermissionRequest(
  request: RequestPermissionRequest,
  context: AcpPermissionContext,
): RequestPermissionResponse {
  if (context.abortRequested) {
    return { outcome: { outcome: "cancelled" } };
  }

  const allowOnce = optionOfKind(request.options, "allow_once");
  const rejectOnce = optionOfKind(request.options, "reject_once");
  const rejectAlways = optionOfKind(request.options, "reject_always");
  const allowAlways = optionOfKind(request.options, "allow_always");
  const reject = rejectOnce ?? rejectAlways;
  const allow = allowOnce ?? allowAlways;
  const toolKind = request.toolCall.kind ?? "other";
  const safeAllow = toolKind === "read" || toolKind === "search" || toolKind === "think" || toolKind === "fetch";

  if (context.executionMode === "safe" && !safeAllow) {
    if (reject) return selected(reject.optionId);
    return { outcome: { outcome: "cancelled" } };
  }

  if (allow) return selected(allow.optionId);
  if (reject) return selected(reject.optionId);
  return { outcome: { outcome: "cancelled" } };
}
