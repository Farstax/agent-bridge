import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("slack packaging contract (#943)", () => {
  it("ships the unit, example inputs, manifest and docs the release artifact copies", () => {
    for (const path of ["systemd/agent-bridge-slack-interactive.service", ".env.slack-interactive.example", "examples/slack-app-manifest.yaml", "docs/slack.md", "src/index-slack-interactive.ts"]) {
      expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
    }
    const workflow = read(".github/workflows/release-artifact.yml");
    expect(workflow).toContain("systemd/agent-bridge-slack-interactive.service");
    expect(workflow).toContain('test -f "$root/src/index-slack-interactive.ts"');
    expect(workflow).toContain("docs/slack.md");
    expect(workflow).toContain("examples/slack-app-manifest.yaml");
  });

  it("the service launches the Slack entrypoint from the active release", () => {
    const unit = read("systemd/agent-bridge-slack-interactive.service");
    expect(unit).toContain("src/index-slack-interactive.ts");
    expect(unit).toContain("EnvironmentFile=/etc/default/agent-bridge-slack-interactive");
    expect(unit).not.toMatch(/xox[bap]-/);
  });

  it("the guarded rollout recognises the Slack unit and database role", () => {
    const rollout = read("scripts/rollout-agent-bridge.sh");
    expect(rollout).toContain("agent-bridge-slack-interactive.service");
    expect(rollout).toMatch(/agent-bridge-slack-interactive\.service\) unit_roles\[\$unit\]=slack/);
  });

  it("the manifest requests exactly the documented scopes, events and Socket Mode", () => {
    const manifest = parse(read("examples/slack-app-manifest.yaml"));
    expect(manifest.oauth_config.scopes.bot.sort()).toEqual(["app_mentions:read", "chat:write", "im:history", "users:read"]);
    expect(manifest.settings.event_subscriptions.bot_events.sort()).toEqual(["app_mention", "message.im"]);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.token_rotation_enabled).toBe(false);
    expect(manifest.settings.interactivity.is_enabled).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/channels:history|groups:history|chat:write\.public|commands|webhook/);
  });

  it("declares the reviewed SDK versions as direct production dependencies", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["@slack/socket-mode"]).toBe("3.1.0");
    expect(pkg.dependencies["@slack/web-api"]).toBe("8.2.0");
    expect(pkg.dependencies.undici).toMatch(/^7\./);
  });

  it("contains no downstream product reference", () => {
    for (const path of ["docs/slack.md", "src/slack.ts", "src/slackIdentity.ts", "src/slackIngress.ts", "src/slackDispatch.ts", "src/slackConfig.ts", "src/slackStatus.ts", "src/index-slack-interactive.ts", "examples/slack-app-manifest.yaml", ".env.slack-interactive.example"]) {
      expect(read(path), path).not.toMatch(/farstax|agent-bridge-platform|control-plane/i);
    }
  });
});
