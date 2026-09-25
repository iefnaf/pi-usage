import { describe, expect, it } from "bun:test";
import {
  CLAUDE_USAGE_ENDPOINT,
  detectProvider,
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchKimiUsage,
  readClaudeCodeToken,
  type FetchLike,
  type FetchResponseLike,
} from "../extensions/usage/core.ts";

function jsonResponse(status: number, body: any): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function invalidJsonResponse(status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("bad json");
    },
  };
}

describe("usage core provider detection", () => {
  it("detects openai-codex models as Codex", () => {
    expect(detectProvider({ provider: "openai-codex", id: "gpt-5.4" })).toBe("codex");
    expect(detectProvider({ provider: "openai-codex", id: "gpt-5.5" })).toBe("codex");
  });

  it("detects zai and kimi-coding providers", () => {
    expect(detectProvider({ provider: "zai", id: "glm-4.6" })).toBe("zai");
    expect(detectProvider({ provider: "kimi-coding", id: "k2p7" })).toBe("kimi");
  });

  it("detects pi-claude-bridge models as Claude", () => {
    expect(detectProvider({ provider: "claude-bridge", id: "claude-opus-5-5" })).toBe("claude");
  });

  it("returns null for unsupported/removed providers", () => {
    // Anthropic / Gemini / Antigravity are no longer supported.
    expect(detectProvider({ provider: "anthropic", id: "claude-opus-4" })).toBeNull();
    expect(detectProvider({ provider: "google", id: "gemini-2.5-pro" })).toBeNull();
    expect(detectProvider({ provider: "google-antigravity", id: "x" })).toBeNull();
    expect(detectProvider(undefined)).toBeNull();
    expect(detectProvider("gpt-5.5")).toBeNull();
  });
});

describe("usage core Codex support", () => {
  it("fetches Codex daily and weekly usage from ChatGPT wham response", async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({
        url,
        authorization: String((init?.headers as any)?.Authorization ?? ""),
      });

      return jsonResponse(200, {
        rate_limit: {
          primary_window: { used_percent: 42, reset_after_seconds: 120 },
          secondary_window: { used_percent: 73, reset_after_seconds: 240 },
        },
      });
    };

    const usage = await fetchCodexUsage("codex-token", { fetchFn });

    expect(calls).toEqual([
      {
        url: "https://chatgpt.com/backend-api/wham/usage",
        authorization: "Bearer codex-token",
      },
    ]);
    expect(usage).toEqual({
      session: 42,
      weekly: 73,
      sessionResetsIn: "2m",
      weeklyResetsIn: "4m",
    });
  });

  it("returns explicit Codex errors for HTTP and invalid JSON failures", async () => {
    const badHttp = await fetchCodexUsage("codex-token", {
      fetchFn: async () => jsonResponse(401, {}),
    });
    expect(badHttp.error).toBe("HTTP 401");

    const badJson = await fetchCodexUsage("codex-token", {
      fetchFn: async () => invalidJsonResponse(),
    });
    expect(badJson.error).toBe("invalid JSON response");
  });
});

describe("usage core Kimi support", () => {
  it("fetches Kimi weekly quota and 5h session window from /coding/v1/usages", async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({
        url,
        authorization: String((init?.headers as any)?.Authorization ?? ""),
      });

      return jsonResponse(200, {
        usage: {
          limit: "2048",
          used: "214",
          remaining: "1834",
          resetTime: "2099-01-09T15:23:13.716839300Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "200",
              used: "139",
              remaining: "61",
              resetTime: "2099-01-06T13:33:02.717479433Z",
            },
          },
        ],
      });
    };

    const usage = await fetchKimiUsage("kimi-key", { fetchFn });

    expect(calls).toEqual([
      {
        url: "https://api.kimi.com/coding/v1/usages",
        authorization: "Bearer kimi-key",
      },
    ]);
    // weekly: 214 / 2048 ≈ 10.45 → 10.45 ; session: 139 / 200 = 69.5
    expect(usage.session).toBe(69.5);
    expect(usage.weekly).toBe(10.45);
    expect(usage.error).toBeUndefined();
  });

  it("returns explicit Kimi errors for HTTP and invalid JSON failures", async () => {
    const badHttp = await fetchKimiUsage("kimi-key", {
      fetchFn: async () => jsonResponse(401, {}),
    });
    expect(badHttp.error).toBe("HTTP 401");

    const badJson = await fetchKimiUsage("kimi-key", {
      fetchFn: async () => invalidJsonResponse(),
    });
    expect(badJson.error).toBe("invalid JSON response");
  });
});

describe("usage core Claude support", () => {
  // Trimmed from a live /api/oauth/usage response.
  const inTwoHours = new Date(Date.now() + 2 * 3600_000 + 30_000).toISOString();
  const inThreeDays = new Date(Date.now() + 3 * 86400_000 + 30_000).toISOString();
  const claudeBody = (extraUsage: any) => ({
    five_hour: { utilization: 11.0, resets_at: inTwoHours },
    seven_day: { utilization: 16.0, resets_at: inThreeDays },
    seven_day_opus: null,
    extra_usage: extraUsage,
  });

  it("fetches 5h and 7d utilization from /api/oauth/usage with the OAuth beta header", async () => {
    const calls: Array<{ url: string; headers: any }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return jsonResponse(200, claudeBody({ is_enabled: false, monthly_limit: 19700, used_credits: 0, decimal_places: 2 }));
    };

    const usage = await fetchClaudeUsage("claude-token", { fetchFn });

    expect(calls).toEqual([
      {
        url: CLAUDE_USAGE_ENDPOINT,
        headers: { Authorization: "Bearer claude-token", "anthropic-beta": "oauth-2025-04-20" },
      },
    ]);
    expect(usage).toEqual({ session: 11, weekly: 16, sessionResetsIn: "2h", weeklyResetsIn: "3d" });
  });

  it("reads utilization as a percent, not a fraction", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(200, { five_hour: { utilization: 0.5 }, seven_day: { utilization: 1 } });
    const usage = await fetchClaudeUsage("t", { fetchFn });
    expect(usage.session).toBe(0.5);
    expect(usage.weekly).toBe(1);
  });

  it("reports enabled extra usage in currency units", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(200, claudeBody({ is_enabled: true, monthly_limit: 19700, used_credits: 1234, decimal_places: 2 }));
    const usage = await fetchClaudeUsage("t", { fetchFn });
    expect(usage.extraSpend).toBe(12.34);
    expect(usage.extraLimit).toBe(197);
  });

  it("returns explicit Claude errors for HTTP, invalid JSON, and unknown shapes", async () => {
    expect(await fetchClaudeUsage("t", { fetchFn: async () => jsonResponse(401, {}) })).toEqual({
      session: 0, weekly: 0, error: "HTTP 401",
    });
    expect(await fetchClaudeUsage("t", { fetchFn: async () => invalidJsonResponse() })).toEqual({
      session: 0, weekly: 0, error: "invalid JSON response",
    });
    expect(await fetchClaudeUsage("t", { fetchFn: async () => jsonResponse(200, {}) })).toEqual({
      session: 0, weekly: 0, error: "unrecognized response shape",
    });
  });
});

describe("Claude Code credentials", () => {
  const now = 1_790_000_000_000;
  const creds = (accessToken: string, expiresAt = now + 3600_000) =>
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "r", expiresAt } });
  const missing = () => {
    throw new Error("not found");
  };

  it("reads the macOS keychain item Claude Code writes", () => {
    const services: string[] = [];
    const result = readClaudeCodeToken({
      platform: "darwin",
      now,
      readKeychain: (service) => (services.push(service), creds("from-keychain")),
      readFile: missing,
    });
    expect(result).toEqual({ token: "from-keychain" });
    expect(services).toEqual(["Claude Code-credentials"]);
  });

  it("falls back to .credentials.json in CLAUDE_CONFIG_DIR, or ~/.claude", () => {
    const paths: string[] = [];
    const readFile = (path: string) => (paths.push(path), creds("from-file"));
    expect(readClaudeCodeToken({ platform: "linux", env: {}, home: "/home/u", now, readFile })).toEqual({ token: "from-file" });
    expect(readClaudeCodeToken({ platform: "darwin", env: { CLAUDE_CONFIG_DIR: "/cfg" }, now, readKeychain: missing, readFile })).toEqual({ token: "from-file" });
    expect(paths).toEqual(["/home/u/.claude/.credentials.json", "/cfg/.credentials.json"]);
  });

  it("reports an expired login instead of refreshing it", () => {
    const result = readClaudeCodeToken({ platform: "linux", env: {}, now, readFile: () => creds("old", now - 1) });
    expect("error" in result && result.error).toMatch(/expired/);
  });

  it("reports a missing or unreadable login", () => {
    expect(readClaudeCodeToken({ platform: "linux", env: {}, now, readFile: missing })).toEqual({
      error: "Claude Code login not found; run `claude` and log in",
    });
    expect("error" in readClaudeCodeToken({ platform: "linux", env: {}, now, readFile: () => "{not json" })).toBe(true);
  });
});
