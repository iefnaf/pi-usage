# pi-usage

A lightweight pi extension that provides a single `/usage` command to display the **current provider's** usage limits (daily & weekly, plus monthly for OpenCode Go).

## Install

```
pi install npm:pi-usage
```

## Usage

In pi, type:

```
/usage
```

A panel appears showing the current provider's usage limits with progress bars (Rolling/Weekly/Monthly for OpenCode Go, Daily/Weekly otherwise). Press Enter or Escape to close.

## Supported Providers

| Provider | Auth Method |
|----------|-------------|
| Codex (OpenAI) | OAuth (`/login`) |
| Anthropic (Claude) | OAuth (`/login`) |
| Z.AI | API key |
| Gemini CLI | OAuth (`/login`) |
| Antigravity (Google) | OAuth (`/login`) |
| OpenCode Go | API key (`/connect` → OpenCode Go) |

## Credits

The usage fetching, auth handling, and provider detection logic are adapted from [pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars) by [@ajarellanod](https://github.com/ajarellanod). Many thanks for the excellent work that made this lightweight version possible.

## License

MIT
