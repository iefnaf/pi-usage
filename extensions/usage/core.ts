/**
 * Usage data layer for the /usage command.
 *
 * Pure fetch + parse logic. Auth resolution (OAuth refresh, env API keys) is
 * the runtime's job — the extension resolves a usable bearer/api key token via
 * `ctx.modelRegistry.getApiKeyForProvider()` and hands it to these functions.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProviderKey = "codex" | "zai" | "kimi" | "claude";

/** Runtime model.provider id for each supported ProviderKey. */
export const PROVIDER_IDS: Record<ProviderKey, string> = {
  codex: "openai-codex",
  zai: "zai",
  kimi: "kimi-coding",
  claude: "claude-bridge",
};

export interface UsageData {
  session: number;
  weekly: number;
  sessionResetsIn?: string;
  weeklyResetsIn?: string;
  extraSpend?: number;
  extraLimit?: number;
  error?: string;
}

export interface UsageEndpoints {
  zai: string;
  kimi: string;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface RequestConfig {
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export interface FetchConfig extends RequestConfig {
  endpoints?: UsageEndpoints;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;

export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const DEFAULT_ZAI_USAGE_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
export const DEFAULT_KIMI_USAGE_ENDPOINT = "https://api.kimi.com/coding/v1/usages";
export const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

export function resolveUsageEndpoints(): UsageEndpoints {
  return {
    zai: DEFAULT_ZAI_USAGE_ENDPOINT,
    kimi: DEFAULT_KIMI_USAGE_ENDPOINT,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timeout";
    return error.message || String(error);
  }
  return String(error);
}

function normalizeUsagePair(session: number, weekly: number): { session: number; weekly: number } {
  const clean = (v: number) => {
    if (!Number.isFinite(v)) return 0;
    return Number(v.toFixed(2));
  };
  return { session: clean(session), weekly: clean(weekly) };
}

async function requestJson(
  url: string,
  init: RequestInit,
  config: RequestConfig = {},
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const fetchFn = config.fetchFn ?? ((fetch as unknown) as FetchLike);
  const timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

    try {
      const data = await response.json();
      return { ok: true, data };
    } catch {
      return { ok: false, error: "invalid JSON response" };
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

export function formatResetsAt(isoDate: string, nowMs = Date.now()): string {
  const resetTime = new Date(isoDate).getTime();
  if (!Number.isFinite(resetTime)) return "";
  const diffSeconds = Math.max(0, (resetTime - nowMs) / 1000);
  return formatDuration(diffSeconds);
}

export function readPercentCandidate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  if (value >= 0 && value <= 1) {
    if (Number.isInteger(value)) return value;
    return value * 100;
  }

  if (value >= 0 && value <= 100) return value;
  return null;
}

export function readLimitPercent(limit: any): number | null {
  const direct = [
    limit?.percentage,
    limit?.utilization,
    limit?.used_percent,
    limit?.usedPercent,
    limit?.usagePercent,
    limit?.usage_percent,
  ]
    .map(readPercentCandidate)
    .find((v) => v != null);

  if (direct != null) return direct;

  const current = typeof limit?.currentValue === "number" ? limit.currentValue : null;
  const remaining = typeof limit?.remaining === "number" ? limit.remaining : null;

  if (current != null && remaining != null && current + remaining > 0) {
    return (current / (current + remaining)) * 100;
  }

  return null;
}

export function extractUsageFromPayload(data: any): { session: number; weekly: number } | null {
  const limitArrays = [data?.data?.limits, data?.limits, data?.quota?.limits, data?.data?.quota?.limits];
  const limits = limitArrays.find((arr) => Array.isArray(arr)) as any[] | undefined;

  if (limits) {
    const byType = (types: string[]) =>
      limits.find((l) => {
        const t = String(l?.type || "").toUpperCase();
        return types.some((x) => t === x);
      });

    const sessionLimit = byType(["TIME_LIMIT", "SESSION_LIMIT", "REQUEST_LIMIT", "RPM_LIMIT", "RPD_LIMIT"]);
    const weeklyLimit = byType(["TOKENS_LIMIT", "TOKEN_LIMIT", "WEEK_LIMIT", "WEEKLY_LIMIT", "TPM_LIMIT", "DAILY_LIMIT"]);

    const s = readLimitPercent(sessionLimit);
    const w = readLimitPercent(weeklyLimit);
    if (s != null && w != null) return normalizeUsagePair(s, w);
  }

  const sessionCandidates = [
    data?.session,
    data?.sessionPercent,
    data?.session_percent,
    data?.five_hour?.utilization,
    data?.rate_limit?.primary_window?.used_percent,
    data?.limits?.session?.utilization,
    data?.usage?.session,
    data?.data?.session,
    data?.data?.sessionPercent,
    data?.data?.session_percent,
    data?.data?.usage?.session,
    data?.quota?.session?.percentage,
    data?.data?.quota?.session?.percentage,
  ];

  const weeklyCandidates = [
    data?.weekly,
    data?.weeklyPercent,
    data?.weekly_percent,
    data?.seven_day?.utilization,
    data?.rate_limit?.secondary_window?.used_percent,
    data?.limits?.weekly?.utilization,
    data?.usage?.weekly,
    data?.data?.weekly,
    data?.data?.weeklyPercent,
    data?.data?.weekly_percent,
    data?.data?.usage?.weekly,
    data?.quota?.weekly?.percentage,
    data?.data?.quota?.weekly?.percentage,
    data?.quota?.daily?.percentage,
    data?.data?.quota?.daily?.percentage,
  ];

  const session = sessionCandidates.map(readPercentCandidate).find((v) => v != null);
  const weekly = weeklyCandidates.map(readPercentCandidate).find((v) => v != null);

  if (session == null || weekly == null) return null;
  return normalizeUsagePair(session, weekly);
}

export async function fetchCodexUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    CODEX_USAGE_ENDPOINT,
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: (result as { ok: false; error: string }).error };

  const primary = result.data?.rate_limit?.primary_window;
  const secondary = result.data?.rate_limit?.secondary_window;

  return {
    session: readPercentCandidate(primary?.used_percent) ?? 0,
    weekly: readPercentCandidate(secondary?.used_percent) ?? 0,
    sessionResetsIn:
      typeof primary?.reset_after_seconds === "number" ? formatDuration(primary.reset_after_seconds) : undefined,
    weeklyResetsIn:
      typeof secondary?.reset_after_seconds === "number" ? formatDuration(secondary.reset_after_seconds) : undefined,
  };
}

export async function fetchZaiUsage(token: string, config: FetchConfig = {}): Promise<UsageData> {
  const endpoint = (config.endpoints ?? resolveUsageEndpoints()).zai;
  if (!endpoint) return { session: 0, weekly: 0, error: "usage endpoint unavailable" };

  const result = await requestJson(
    endpoint,
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: (result as { ok: false; error: string }).error };

  const parsed = extractUsageFromPayload(result.data);
  if (!parsed) return { session: 0, weekly: 0, error: "unrecognized response shape" };
  return parsed;
}

/**
 * Derive a usage percentage from a Kimi quota bucket, which reports string
 * `used` / `remaining` / `limit` values. Prefers used/(used+remaining), falls
 * back to used/limit.
 */
export function percentFromQuotaBucket(bucket: any): number | null {
  if (!bucket) return null;
  const used = Number(bucket?.used);
  const remaining = Number(bucket?.remaining);
  const limit = Number(bucket?.limit);

  if (Number.isFinite(used) && Number.isFinite(remaining) && used + remaining > 0) {
    return (used / (used + remaining)) * 100;
  }
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return (used / limit) * 100;
  }
  return null;
}

/**
 * Fetch Kimi For Coding usage.
 *
 * `GET https://api.kimi.com/coding/v1/usages` returns:
 *   - `usage`: weekly membership quota ({limit, used, remaining, resetTime})
 *   - `limits[0]`: ~5-hour rolling rate-limit window (same detail shape)
 */
export async function fetchKimiUsage(token: string, config: FetchConfig = {}): Promise<UsageData> {
  const endpoint = (config.endpoints ?? resolveUsageEndpoints()).kimi;
  if (!endpoint) return { session: 0, weekly: 0, error: "usage endpoint unavailable" };

  const result = await requestJson(
    endpoint,
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: (result as { ok: false; error: string }).error };

  const data = result.data;
  const weeklyBucket = data?.usage;
  const sessionBucket = Array.isArray(data?.limits) ? data.limits[0]?.detail : undefined;

  const session = percentFromQuotaBucket(sessionBucket);
  const weekly = percentFromQuotaBucket(weeklyBucket);
  if (session == null && weekly == null) {
    return { session: 0, weekly: 0, error: "unrecognized response shape" };
  }

  return normalizeUsagePair(session ?? 0, weekly ?? 0);
}

export function detectProvider(
  model: { provider?: string; id?: string; name?: string; api?: string } | string | undefined | null,
): ProviderKey | null {
  if (!model || typeof model === "string") return null;

  const provider = (model.provider || "").toLowerCase();

  if (provider === "openai-codex") return "codex";
  if (provider === "zai") return "zai";
  if (provider === "kimi-coding") return "kimi";
  if (provider === "claude-bridge") return "claude";

  return null;
}

export function providerToProviderId(active: ProviderKey | null): string | null {
  if (!active) return null;
  return PROVIDER_IDS[active] ?? null;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function colorForPercent(value: number): "success" | "warning" | "error" {
  if (value >= 90) return "error";
  if (value >= 70) return "warning";
  return "success";
}

// ── Claude (via pi-claude-bridge) ────────────────────────────────

/**
 * Fetch Claude subscription usage.
 *
 * `GET https://api.anthropic.com/api/oauth/usage` (the endpoint Claude Code's
 * own /usage reads) returns, among other buckets:
 *   - `five_hour` / `seven_day`: `{ utilization, resets_at }`, utilization in
 *     percent (0..100) and resets_at an ISO timestamp
 *   - `extra_usage`: `{ is_enabled, used_credits, monthly_limit, decimal_places }`,
 *     amounts in minor currency units (cents for `decimal_places: 2`)
 */
export async function fetchClaudeUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    CLAUDE_USAGE_ENDPOINT,
    { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: (result as { ok: false; error: string }).error };

  const data = result.data;
  const percent = (bucket: any): number | null =>
    typeof bucket?.utilization === "number" && Number.isFinite(bucket.utilization) ? bucket.utilization : null;
  const session = percent(data?.five_hour);
  const weekly = percent(data?.seven_day);
  if (session == null && weekly == null) {
    return { session: 0, weekly: 0, error: "unrecognized response shape" };
  }

  const usage: UsageData = {
    ...normalizeUsagePair(session ?? 0, weekly ?? 0),
    sessionResetsIn: data?.five_hour?.resets_at ? formatResetsAt(data.five_hour.resets_at) : undefined,
    weeklyResetsIn: data?.seven_day?.resets_at ? formatResetsAt(data.seven_day.resets_at) : undefined,
  };

  const extra = data?.extra_usage;
  if (extra?.is_enabled && typeof extra.used_credits === "number" && typeof extra.monthly_limit === "number") {
    const scale = 10 ** (typeof extra.decimal_places === "number" ? extra.decimal_places : 2);
    usage.extraSpend = extra.used_credits / scale;
    usage.extraLimit = extra.monthly_limit / scale;
  }

  return usage;
}

export interface ClaudeCodeCredentialDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: number;
  /** Returns the macOS keychain secret, throwing when the item is missing. */
  readKeychain?: (service: string) => string;
  readFile?: (path: string) => string;
}

const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Claude Code's OAuth access token, as Claude Code stores it: the macOS
 * keychain item "Claude Code-credentials", or `.credentials.json` in its config
 * dir (`CLAUDE_CONFIG_DIR`, default `~/.claude`) elsewhere.
 *
 * pi-claude-bridge runs Claude Code, so pi's model registry holds no usable
 * token for it. An expired token is reported rather than refreshed: refreshing
 * rotates the refresh token and would invalidate the copy Claude Code holds.
 * Claude Code refreshes it itself on its next request.
 */
export function readClaudeCodeToken(deps: ClaudeCodeCredentialDeps = {}): { token: string } | { error: string } {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const readKeychain =
    deps.readKeychain ??
    ((service: string) =>
      execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const configDir = env.CLAUDE_CONFIG_DIR || join(deps.home ?? homedir(), ".claude");

  const sources: Array<() => string> = [];
  if (platform === "darwin") sources.push(() => readKeychain(CLAUDE_CODE_KEYCHAIN_SERVICE));
  sources.push(() => readFile(join(configDir, ".credentials.json")));

  for (const read of sources) {
    let raw: string;
    try {
      raw = read();
    } catch {
      continue;
    }
    let oauth: any;
    try {
      oauth = JSON.parse(raw)?.claudeAiOauth;
    } catch {
      continue;
    }
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) continue;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= (deps.now ?? Date.now())) {
      return { error: "Claude Code login expired; run a claude-bridge request or `claude` once to refresh it" };
    }
    return { token: oauth.accessToken };
  }

  return { error: "Claude Code login not found; run `claude` and log in" };
}
