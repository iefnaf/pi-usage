import { describe, expect, it } from "bun:test";
import {
  detectProvider,
  fetchCodexUsage,
  fetchKimiUsage,
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
