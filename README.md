# pi-usage

A lightweight pi extension that provides a single `/usage` command to display the **current provider's** daily and weekly usage limits.

## Install

```
pi install npm:pi-usage
```

## Usage

In pi, type:

```
/usage
```

A panel appears showing the current provider's daily and weekly limits with progress bars. Press Enter or Escape to close.

## Supported Providers

| Provider | Auth Method |
|----------|-------------|
| Codex (OpenAI) | OAuth (`/login`) |
| Z.AI | API key (`ZAI_API_KEY`) |
| Kimi For Coding | API key (`KIMI_API_KEY`) |
| Claude (via [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)) | Claude Code login (macOS keychain, or `~/.claude/.credentials.json`) |

Usage is shown for the **current** provider. Auth (including Codex OAuth
refresh and env API keys) is resolved through pi's model registry, so as long
as the active model is working, `/usage` can read its limits.

Claude models served by `pi-claude-bridge` run through Claude Code, so `/usage`
reads Claude Code's own login rather than pi's. It never refreshes that token,
since refreshing would invalidate the copy Claude Code holds; Claude Code
refreshes it on its next request.

## Credits

The usage fetching, auth handling, and provider detection logic are adapted from [pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars) by [@ajarellanod](https://github.com/ajarellanod). Many thanks for the excellent work that made this lightweight version possible.

## License

MIT
