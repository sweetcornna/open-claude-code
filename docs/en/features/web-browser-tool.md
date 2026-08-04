<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/web-browser-tool) · [日本語](/docs/ja/features/web-browser-tool)

# WEB_BROWSER_TOOL — Browser Tool

> Feature Flag: `FEATURE_WEB_BROWSER_TOOL=1`
> Implementation status: Core tool implemented, panel stubbed, wiring complete
> Reference count: 4

## 1. Feature overview

WEB_BROWSER_TOOL allows the model to launch browser instances, navigate web pages, and interact with page elements. It uses Bun's built-in WebView API to provide headless and headed browser capabilities.

## 2. Implementation architecture

### 2.1 Module status

| Module | File | Status |
|------|------|------|
| Browser panel | `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserPanel.ts` | **Stub** — returns null |
| Browser tool | `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserTool.ts` | **Implemented** |
| REPL integration | `src/screens/REPL.tsx` | **Wired** — renders WebBrowserPanel |
| Tool registration | `src/tools.ts` | **Wired** — loads dynamically |
| WebView detection | `src/main.tsx` | **Wired** — checks `'WebView' in Bun` |

### 2.2 Expected data flow

```
Model invokes WebBrowserTool
         │
         ▼
Bun WebView creates a browser instance
         │
         ├── navigate(url) — navigate to a URL
         ├── click(selector) — click an element
         ├── screenshot() — capture a page screenshot
         └── extract(selector) — extract page content
         │
         ▼
Result returned to the model
         │
         ▼
WebBrowserPanel displays browser status in the REPL sidebar
```

## 3. Incomplete work

| Module | Effort | Description |
|------|--------|------|
| `WebBrowserTool.ts` | Implemented | Tool schema and execution through the Bun WebView API |
| `WebBrowserPanel.tsx` | Medium | Browser-status panel in the REPL sidebar (still a stub) |

## 4. Key design decisions

1. **Bun WebView API**: Use Bun's built-in WebView rather than an external browser driver (Puppeteer/Playwright)
2. **REPL side panel**: Render browser status independently within the REPL layout
3. **Bun feature detection**: Check whether the runtime supports WebView with `'WebView' in Bun`

## 5. Usage

```bash
FEATURE_WEB_BROWSER_TOOL=1 bun run dev
```

## 6. File index

| File | Responsibility |
|------|------|
| `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserPanel.ts` | Panel component (stub) |
| `packages/builtin-tools/src/tools/WebBrowserTool/WebBrowserTool.ts` | Tool implementation (implemented) |
| `src/screens/REPL.tsx:471,5676` | Panel rendering |
| `src/tools.ts:115-116` | Tool registration |
