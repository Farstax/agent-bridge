import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
function contents(path: string): string { return readFileSync(join(root, path), "utf8"); }

describe("supported-surface onboarding documentation (#1003)", () => {
  it("makes Telegram, Discord and Slack discoverable from README and both documentation indexes", () => {
    const readme = contents("README.md");
    const index = contents("docs/README.md");
    const examples = contents("docs/examples/README.md");
    for (const surface of ["Telegram", "Discord", "Slack"]) {
      expect(readme).toContain(surface);
      expect(index).toContain(surface);
      expect(examples).toContain(surface);
    }
  });

  it("documents the actual executable standalone entrypoints and guided surface selection", () => {
    const tg = contents("docs/examples/telegram-multi-provider.md");
    const discord = contents("docs/examples/discord-interactive.md");
    const slack = contents("docs/slack.md");
    expect(tg).toContain("npm run setup -- --surface telegram");
    expect(discord).toContain("npm run setup -- --surface discord");
    expect(discord).toContain("src/index-discord-interactive.ts");
    expect(slack).toContain("npm run setup -- --surface slack");
    expect(slack).toContain("src/index-slack-interactive.ts");
    expect(slack).toContain("connections:write");
    expect(slack).toContain("!cli");
  });

  it("distinguishes standalone source bootstrap from immutable production installation", () => {
    const initial = contents("docs/INITIAL-INSTALL.md");
    const slack = contents("docs/slack.md");
    expect(initial).toContain("SLACK_BOT_TOKEN_FILE");
    expect(initial).toContain("SLACK_APP_TOKEN_FILE");
    expect(initial).toContain("SLACK_ALLOWED_USER_IDS");
    expect(initial).toContain("agent-bridge-install.py");
    expect(slack).toContain("--role slack");
    expect(slack).toContain("Socket Mode");
  });
});
