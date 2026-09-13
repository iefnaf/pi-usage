/**
 * Simple Usage Extension for pi
 *
 * Provides a single /usage command that shows the current provider's
 * daily (session) and weekly limits in a TUI panel.
 */

import { AuthStorage, DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Container, Spacer, Text, type Focusable } from "@earendil-works/pi-tui";
import {
  clampPercent,
  colorForPercent,
  detectProvider,
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchGoogleUsage,
  fetchZaiUsage,
  providerToOAuthProviderId,
  resolveUsageEndpoints,
  type ProviderKey,
  type UsageData,
  type UsageEndpoints,
} from "./core.js";

// ── Provider labels ──────────────────────────────────────────────

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  codex: "Codex",
  claude: "Claude",
  zai: "Z.AI",
  gemini: "Gemini",
  antigravity: "Antigravity",
};

// ── Self-managing usage panel ────────────────────────────────────

class UsagePanelComponent extends Container implements Focusable {
  private _focused = false;
  private tui: any;
  private theme: any;
  private onDone: () => void;

  // Mutable content area (everything between the two borders)
  private contentContainer = new Container();

  get focused() {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
  }

  constructor(
    tui: any,
    theme: any,
    provider: ProviderKey,
    fetchPromise: Promise<UsageData | null>,
    onDone: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;

    // Static structure: top border → content → bottom border
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(this.contentContainer);
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    // Show loading state
    this.renderLoading(provider);

    // Kick off fetch – when it resolves, rebuild content in place
    fetchPromise
      .then((data) => this.renderResult(provider, data))
      .catch((err) =>
        this.renderResult(provider, {
          session: 0,
          weekly: 0,
          error: String(err?.message ?? err),
        }),
      );
  }

  // ── Renderers ────────────────────────────────────────────────

  private renderLoading(provider: ProviderKey) {
    this.contentContainer.clear();
    const t = this.theme;
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(
      new Text(
        "  " + t.fg("accent", t.bold(PROVIDER_LABELS[provider] ?? provider)) + " Usage",
        0,
        0,
      ),
    );
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(
      new Text("  " + t.fg("muted", "Fetching usage data…"), 0, 0),
    );
    this.contentContainer.addChild(new Spacer(1));
  }

  private renderResult(provider: ProviderKey, data: UsageData | null) {
    this.contentContainer.clear();
    const t = this.theme;
    const label = PROVIDER_LABELS[provider] ?? provider;

    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(
      new Text("  " + t.fg("accent", t.bold(label)) + " Usage", 0, 0),
    );
    this.contentContainer.addChild(new Spacer(1));

    if (!data) {
      this.contentContainer.addChild(
        new Text("  " + t.fg("dim", "No credentials found for this provider."), 0, 0),
      );
    } else if (data.error) {
      this.contentContainer.addChild(
        new Text("  " + t.fg("error", `Error: ${data.error}`), 0, 0),
      );
    } else {
      const session = clampPercent(data.session);
      const sessionReset = data.sessionResetsIn
        ? t.fg("dim", `  resets in ${data.sessionResetsIn}`)
        : "";
      this.contentContainer.addChild(
        new Text(
          "  " +
            t.fg("muted", "Daily    ") +
            renderBar(t, session) +
            " " +
            t.fg(colorForPercent(session), `${session}%`.padStart(4)) +
            sessionReset,
          0,
          0,
        ),
      );

      const weekly = clampPercent(data.weekly);
      const weeklyReset = data.weeklyResetsIn
        ? t.fg("dim", `  resets in ${data.weeklyResetsIn}`)
        : "";
      this.contentContainer.addChild(
        new Text(
          "  " +
            t.fg("muted", "Weekly   ") +
            renderBar(t, weekly) +
            " " +
            t.fg(colorForPercent(weekly), `${weekly}%`.padStart(4)) +
            weeklyReset,
          0,
          0,
        ),
      );

      if (typeof data.extraSpend === "number" && typeof data.extraLimit === "number") {
        this.contentContainer.addChild(
          new Text(
            "  " +
              t.fg("muted", "Extra    ") +
              t.fg("dim", `$${data.extraSpend.toFixed(2)} / $${data.extraLimit}`),
            0,
            0,
          ),
        );
      }
    }

    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(
      new Text("  " + t.fg("dim", "Press Enter or Escape to close"), 0, 0),
    );
    this.contentContainer.addChild(new Spacer(1));

    // ← This is the key fix: trigger a TUI re-render after content changes
    this.tui.requestRender();
  }

  // ── Input ────────────────────────────────────────────────────

  handleInput(keyData: string): void {
    // Use matchesKey for raw key matching – no dependency on keybinding config
    if (matchesKey(keyData, "return") || matchesKey(keyData, "escape")) {
      this.onDone();
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function renderBar(theme: any, value: number, width = 20): string {
  const v = clampPercent(value);
  const filled = Math.round((v / 100) * width);
  const full = "█".repeat(Math.max(0, Math.min(width, filled)));
  const empty = "░".repeat(Math.max(0, width - filled));
  return theme.fg(colorForPercent(v), full) + theme.fg("dim", empty);
}

async function getAccessToken(providerId: string): Promise<string | null> {
  try {
    const auth = AuthStorage.create();
    return (await auth.getApiKey(providerId)) ?? null;
  } catch {
    return null;
  }
}

async function fetchProviderUsage(
  provider: ProviderKey,
  endpoints: UsageEndpoints,
): Promise<UsageData | null> {
  const oauthId = providerToOAuthProviderId(provider);

  switch (provider) {
    case "codex": {
      const access = oauthId ? await getAccessToken(oauthId) : null;
      return access
        ? fetchCodexUsage(access)
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    }
    case "claude": {
      const access = oauthId ? await getAccessToken(oauthId) : null;
      return access
        ? fetchClaudeUsage(access)
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    }
    case "zai": {
      const token = process.env.ZAI_API_KEY || (oauthId ? await getAccessToken(oauthId) : null);
      return token
        ? fetchZaiUsage(token, { endpoints })
        : { session: 0, weekly: 0, error: "missing token (set ZAI_API_KEY or try /login again)" };
    }
    case "gemini": {
      const access = oauthId ? await getAccessToken(oauthId) : null;
      // AuthStorage manages projectId internally via auth.json
      return access
        ? fetchGoogleUsage(access, endpoints.gemini, undefined, "gemini", { endpoints })
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    }
    case "antigravity": {
      const access = oauthId ? await getAccessToken(oauthId) : null;
      return access
        ? fetchGoogleUsage(access, endpoints.antigravity, undefined, "antigravity", { endpoints })
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    }
    default:
      return null;
  }
}

// ── Extension entry point ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const endpoints = resolveUsageEndpoints();

  pi.registerCommand("usage", {
    description: "Show current provider's daily & weekly usage limits",
    handler: async (_args, ctx) => {
      if (!ctx?.hasUI) return;

      const provider = detectProvider(ctx.model);
      if (!provider) {
        ctx.ui.notify(
          "Cannot detect current provider – usage data unavailable",
          "warning",
        );
        return;
      }

      const auth = AuthStorage.create();
      const oauthId = providerToOAuthProviderId(provider);

      // Z.AI uses ZAI_API_KEY env var, not OAuth
      if (provider === "zai" && !process.env.ZAI_API_KEY && !(oauthId && auth.hasAuth(oauthId))) {
        ctx.ui.notify("No ZAI_API_KEY found (set env var or run /login)", "warning");
        return;
      }

      if (provider !== "zai" && oauthId && !auth.hasAuth(oauthId)) {
        ctx.ui.notify(
          `No credentials found for ${PROVIDER_LABELS[provider] ?? provider}`,
          "warning",
        );
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const fetchPromise = fetchProviderUsage(provider, endpoints);
        return new UsagePanelComponent(tui, theme, provider, fetchPromise, () => done());
      });
    },
  });
}
