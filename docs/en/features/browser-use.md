<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/browser-use) · [日本語](/docs/ja/features/browser-use)

# Browser tools (browser-use)

## 1. What it does

occ's browser control comes from [`browser-use`](https://github.com/browser-use/browser-use). occ launches it as a stdio MCP server, and it drives a real Chrome/Chromium:

- Read page state (`browser_get_state`) — what is on the page and what is interactable
- Extract content (`browser_extract_content`) — for when you want the page's information rather than its structure; far cheaper than reasoning over raw state
- Navigate, click, type, scroll, go back
- Manage tabs and sessions
- `retry_with_browser_use_agent` — hand a whole task to an autonomous browsing agent

> **This replaced chrome-devtools-mcp, which has been removed.** That server exposed the raw DevTools surface (network requests, console, performance traces, Lighthouse). The trade is semantic actions in exchange for those DevTools-only capabilities — if you depend on them, this release is not for you.

## 2. Requirements

| Requirement | Notes |
|---|---|
| `uvx` | **Required.** browser-use is a Python tool. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) |
| Chrome / Chromium | **Required.** browser-use drives a real browser |
| Model credentials | See below. Nothing to configure if you signed in with OAuth |
| Subscription | **Not required.** This is a local process; nothing goes through Anthropic |

`--chrome` probes for `uvx` up front and exits with the install URL if it is missing, rather than handing a bare ENOENT to the MCP layer — that error tells you nothing actionable.

## 3. Credentials

browser-use makes its own model calls (the autonomous agent, and the extraction path), so it needs credentials of its own. occ handles this for you:

- **Signed in with an API key**: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is already in the environment and the subprocess inherits it. occ does not touch it.
- **Signed in with OAuth**: there is no key anywhere, only an access token in the keychain. occ passes it as `ANTHROPIC_AUTH_TOKEN`, the Anthropic SDK's bearer variable.

Anything you set explicitly is never overridden.

## 4. Enabling it

| How | Notes |
|---|---|
| `occ --chrome` | Enable for this session |
| `occ --no-chrome` | Force off for this session; highest precedence |
| `CLAUDE_CODE_ENABLE_CFC=1` | Enable via environment |
| `/chrome` panel | Check status, toggle "enabled by default" |
| Config key `browserToolDefaultEnabled` | Persistent default (the old `chromeDevtoolsDefaultEnabled` is still read) |

Non-interactive sessions (SDK, CI, `-p`) default to off unless `--chrome` was passed explicitly.

## 5. Permissions

Only four **observational** tools are pre-approved and skip the permission prompt:

`browser_get_state`, `browser_extract_content`, `browser_list_tabs`, `browser_list_sessions`

Everything else goes through the normal MCP permission flow — including `retry_with_browser_use_agent`, which acts on its own for many steps and so needs your approval most of all.

The gate is deliberate: this drives a real, possibly logged-in browser.

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| `browser tools need \`uvx\`` | uv is not installed. See Requirements |
| Authentication error on the first call after the server starts | browser-use has no model credentials. Check that you are signed in, or set `ANTHROPIC_API_KEY` yourself |
| Reports no browser found | Chrome/Chromium is not installed. `occ doctor` shows what was detected |
| Tool names cannot be called | With tool search on, MCP tools load on demand — load `mcp__browser-use__*` via SearchExtraTools first |

## 7. Reference

- Upstream repository: https://github.com/browser-use/browser-use
- MCP server docs: https://docs.browser-use.com/customize/mcp-server
