<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/chrome-devtools-mcp) · [日本語](/docs/ja/features/chrome-devtools-mcp)

# Chrome Browser Tools (chrome-devtools-mcp)

## 1. Feature overview

occ's browser control is provided by Google's official [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) project under Apache-2.0. occ launches it as a stdio MCP server, which operates the browser through the Chrome DevTools Protocol:

- List, select, create, and close pages; navigate forward and backward
- Click, type, drag, fill forms, upload files, and handle dialogs
- Capture page accessibility snapshots (`take_snapshot`) and screenshots
- Read console messages and network requests
- Run performance traces and Lighthouse audits
- Emulate devices and resize windows

> **The previous extension-based design has been removed.** occ previously inherited an implementation based on a Chrome extension and native messaging host, but that path recognized only the official Claude Code host identity. Installing it for occ would effectively hijack another product's browser integration. It therefore always failed closed (`--chrome` only printed an error). With a stdio MCP server, occ and the official Claude Code have **no shared identity**: this is simply a subprocess spawned by occ itself.

## 2. Prerequisites

| Requirement | Description |
|------|------|
| Node.js | An LTS version. occ uses it to run the MCP server process |
| Google Chrome | `--autoConnect` requires **Chrome 144+**. Older versions still work, but launch a separate browser with an empty profile |
| Subscription | **Not required**. This is a local process and does not go through Anthropic |

`chrome-devtools-mcp` is a runtime dependency of occ and is installed with the npm package. No separate extension installation or native-host registration is required. If the dependency cannot be resolved at runtime, occ falls back to `npx -y chrome-devtools-mcp@latest`.

## 3. Enabling the tools

```bash
# Development mode
bun run dev -- --chrome

# Build artifact
node dist/cli.js --chrome

# Disable
occ --no-chrome
```

You can also:

- Set the `CLAUDE_CODE_ENABLE_CFC=1` environment variable;
- Enable “Chrome browser tools enabled by default” in the `/config` panel, which writes `chromeDevtoolsDefaultEnabled`.

Precedence is `--chrome` / `--no-chrome` > `CLAUDE_CODE_ENABLE_CFC` > `chromeDevtoolsDefaultEnabled`; the default is disabled. **Non-interactive sessions (SDK / CI / `-p`) do not enable it by default** unless `--chrome` is passed explicitly. Silently launching a browser in CI would not be an appropriate default.

Use `/chrome` in the REPL to view current status: Chrome version, connection mode, connection state, and the default setting.

## 4. Connection modes

### autoConnect (default)

Attaches to the user's **already running** Chrome instance, using the real profile and signed-in state instead of opening an empty browser that requires another login.

Requirements:

- Chrome 144 or newer;
- Remote debugging enabled in that Chrome instance through `chrome://inspect/#remote-debugging`.

When the Chrome version is too old, `chrome-devtools-mcp` launches a browser with a temporary profile. Pages open, but every site is signed out. This fallback is silent, so `occ doctor` reports it in advance.

### browser-url (WSL / remote / container)

Set `OCC_CHROME_BROWSER_URL`; occ then connects with `--browserUrl`:

```bash
# Start Chrome on the Windows side
chrome.exe --remote-debugging-port=9222

# On the WSL side
export OCC_CHROME_BROWSER_URL=http://127.0.0.1:9222
occ --chrome
```

This is the only viable path under WSL: Chrome is installed on Windows, and the Linux namespace has no browser to drive. The same approach applies to remote-desktop and container environments.

### Let the server launch the browser

Set `OCC_CHROME_AUTOCONNECT=0` to omit `--autoConnect` and let `chrome-devtools-mcp` launch Chrome itself. Use this mode when an agent should not access your signed-in browser state.

## 5. Permission model

Full tool names have the form `mcp__chrome-devtools__<tool>` and follow **exactly the same permission flow as every other MCP server**, with one exception:

**No confirmation required (9 read-only observation tools)**

`take_snapshot`, `take_screenshot`, `list_pages`, `list_console_messages`, `get_console_message`, `list_network_requests`, `get_network_request`, `performance_analyze_insight`, `wait_for`

**Confirmation required (all other tools)**

`click`, `drag`, `fill`, `fill_form`, `hover`, `press_key`, `type_text`, `upload_file`, `handle_dialog`, `navigate_page`, `new_page`, `close_page`, `select_page`, `emulate`, `resize_page`, `evaluate_script`, `performance_start_trace`, `performance_stop_trace`, `lighthouse_audit`, `take_heapsnapshot`

The boundary is whether an operation can change browser state. These tools usually drive the user's **own signed-in browser**, so every click, input, navigation, and script execution requires approval. The `chrome-devtools` skill deliberately uses the same read-only list for `allowedTools`: a skill's `allowedTools` become always-allow rules, so including action tools would silently remove this gate.

## 6. Telemetry

occ disables upstream `chrome-devtools-mcp` telemetry by default through both switches officially supported by Google:

- Command line: `--no-usage-statistics`
- Environment variables: `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`, `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`

occ does not send usage statistics to a third party on the user's behalf.

## 7. Diagnostics

`occ doctor` reports:

```
└ Chrome (--chrome): 144.0.7204.50 (autoConnect)
```

When a problem exists, it instead provides a one-line remediation, for example:

- `Chrome not found. Install Google Chrome, or set OCC_CHROME_BROWSER_URL ...`
- `Chrome 138.x is below 144, so --autoConnect cannot attach to it. A separate browser with an empty profile will be launched instead (no logins).`
- `WSL detected. Chrome on the Windows side is not reachable from here — start it with --remote-debugging-port=9222 and set OCC_CHROME_BROWSER_URL=http://127.0.0.1:9222`

## 8. Troubleshooting

### Tools do not appear in the tool list

Confirm that occ was launched with `--chrome`, then use `/mcp` to check whether `chrome-devtools` is connected. When tool search (`EXPERIMENTAL_SEARCH_EXTRA_TOOLS`) is enabled, MCP tools load lazily, so the model must first retrieve them with `SearchExtraTools`. The system prompt already specifies this step.

### Connected, but every site is signed out

`--autoConnect` could not attach, so `chrome-devtools-mcp` opened a separate browser with a temporary profile. Run `occ doctor` to verify that Chrome is version 144 or newer and that remote debugging is enabled at `chrome://inspect/#remote-debugging`.

### Cannot connect under WSL

See the browser-url section above. Chrome is usually not installed in WSL's Linux environment at all.

### When browser functionality is not needed

Launch occ normally without `--chrome`; it does not spawn any browser-related process.

## 9. Related documentation

- Upstream repository and tool reference: https://github.com/ChromeDevTools/chrome-devtools-mcp
- `docs/zh/features/chrome-use-mcp.md` describes **something else**: the third-party `hangwin/mcp-chrome` (an `mcp-chrome` HTTP server on port 12306 that is registered by default but disabled by default). It is unrelated to this document.
