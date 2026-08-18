/** Untrusted provider-side client for the Bridge-owned advisor capability. */
import { requestAdvisorViaBroker } from "./advisorBroker.js";
type EnvLike = Record<string, string | undefined>;
function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? "").trim() : "";
}
export async function runAgentAdvisorCommand(args: string[], env: EnvLike = process.env): Promise<string> {
  const capability = env.AGENT_BRIDGE_ADVISOR_CAPABILITY?.trim();
  if (!capability) throw new Error("AGENT_BRIDGE_ADVISOR_CAPABILITY is required");
  const question = flagValue(args, "--question") || flagValue(args, "--task");
  return requestAdvisorViaBroker({
    capability,
    question,
    ...(flagValue(args, "--context") ? { context: flagValue(args, "--context") } : {}),
    ...(flagValue(args, "--provider") ? { provider: flagValue(args, "--provider") } : {}),
  }, env);
}
