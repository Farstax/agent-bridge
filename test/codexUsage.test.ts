import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchCodexUsage,
  formatCodexUsage,
  readCodexAccessToken,
  selectCodexCapacityResetAt,
} from "../src/codexUsage.js";

const usageFixture = {
  user_id: "user-secret",
  account_id: "acct-secret",
  email: "person@example.com",
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 28,
      limit_window_seconds: 18000,
      reset_after_seconds: 17255,
      reset_at: 1779723687,
    },
    secondary_window: {
      used_percent: 13,
      limit_window_seconds: 604800,
      reset_after_seconds: 474638,
      reset_at: 1780181070,
    },
  },
  credits: {
    has_credits: false,
    unlimited: false,
    overage_limit_reached: false,
  },
};

describe("Codex usage formatting", () => {
  it("formats plan usage and reset times without identity fields", () => {
    const text = formatCodexUsage(usageFixture, "Europe/London");

    expect(text).toContain("Codex usage");
    expect(text).toContain("Plan: plus");
    expect(text).toContain("Primary: 28% used");
    expect(text).toContain("resets 2026-05-25 16:41");
    expect(text).toContain("Secondary: 13% used");
    expect(text).toContain("resets 2026-05-30 23:44");
    expect(text).toContain("Allowed: yes");
    expect(text).toContain("Limit reached: no");
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("user-secret");
    expect(text).not.toContain("acct-secret");
  });
});

describe("Codex capacity reset evidence", () => {
  it("uses the earliest future provider reset only when the usage response confirms a limit", () => {
    expect(selectCodexCapacityResetAt({
      rate_limit: {
        limit_reached: true,
        primary_window: { reset_at: 1_700_000_200 },
        secondary_window: { reset_at: 1_700_000_100 },
      },
    }, 1_700_000_000_000)).toBe("2023-11-14T22:15:00.000Z");
  });

  it("does not turn malformed, stale, or non-limited usage into reset evidence", () => {
    expect(selectCodexCapacityResetAt({ rate_limit: { limit_reached: false, primary_window: { reset_at: 1_700_000_100 } } }, 1_700_000_000_000)).toBeNull();
    expect(selectCodexCapacityResetAt({ rate_limit: { limit_reached: true, primary_window: { reset_at: "bad" } } }, 1_700_000_000_000)).toBeNull();
    expect(selectCodexCapacityResetAt({ rate_limit: { limit_reached: true, primary_window: { reset_at: 1_699_999_999 } } }, 1_700_000_000_000)).toBeNull();
  });
});

describe("Codex usage auth", () => {
  it("reads the ChatGPT OAuth access token from auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-usage-auth-"));
    try {
      const authPath = join(dir, "auth.json");
      writeFileSync(authPath, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "access-token" },
      }));

      expect(readCodexAccessToken(authPath)).toBe("access-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing OAuth access tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-usage-auth-"));
    try {
      const authPath = join(dir, "auth.json");
      writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));

      expect(() => readCodexAccessToken(authPath)).toThrow("Codex OAuth access token is missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex usage fetcher", () => {
  it("fetches usage with the OAuth bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(usageFixture), { status: 200 }));

    const usage = await fetchCodexUsage("access-token", fetchMock);

    expect(usage).toEqual(usageFixture);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          Accept: "application/json",
        }),
      }),
    );
  });

  it("reports auth failures without leaking response bodies", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      body: { cancel },
      json: vi.fn(),
    }));

    await expect(fetchCodexUsage("access-token", fetchMock)).rejects.toThrow("Codex usage request failed with HTTP 401");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
