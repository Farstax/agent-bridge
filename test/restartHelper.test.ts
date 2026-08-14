import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("safe restart helper", () => {
  it("has a default 5 second delay and a fixed agent-bridge unit list", () => {
    const helper = readFileSync(new URL("../scripts/restart-agent-bridge.sh", import.meta.url), "utf8");

    expect(helper).toContain('RESTART_DELAY_SECONDS:-5');
    expect(helper).toContain('sleep "$delay"');
    expect(helper).toContain("agent-bridge-interactive.service");
    expect(helper).toContain('systemctl restart "${units[@]}"');
    expect(helper).toContain("systemctl list-units 'agent-bridge*' --all --no-pager");
    expect(helper).not.toContain("NOPASSWD: ALL");
  });
});
