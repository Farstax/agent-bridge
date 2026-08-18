import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseAutonomyTelegramCommand } from "../src/autonomyTelegram.js";

describe("autonomy Telegram routing precedence (#466)", () => {
  it("keeps /autonomy stop an immediate command even when sent as a reply", () => {
    expect(parseAutonomyTelegramCommand("/autonomy stop")).toBe("stop");
    const source = readFileSync("src/index-interactive.ts", "utf8");
    expect(source.indexOf("const autonomyCommand = parseAutonomyTelegramCommand"))
      .toBeLessThan(source.indexOf("const supervisorReply = matchAutonomousTelegramSupervisorReply"));
  });
});
