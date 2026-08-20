import { describe, expect, it } from "vitest";

import { parseAutonomyTelegramCommand } from "../src/autonomyTelegram.js";

describe("autonomy Telegram routing precedence (#466)", () => {
  it("keeps /autonomy stop an immediate command even when sent as a reply", () => {
    expect(parseAutonomyTelegramCommand("/autonomy stop")).toBe("stop");
  });
});
