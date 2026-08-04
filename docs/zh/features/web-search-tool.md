<!-- lang-switcher -->
[English](/docs/en/features/web-search-tool) · **中文** · [日本語](/docs/ja/features/web-search-tool)

# WEB_SEARCH_TOOL — 网页搜索工具

> 实现状态：适配器架构完成，支持 API / Bing / Brave 三种后端
> 引用数：核心工具，无 feature flag 门控（始终启用）

## 一、功能概述

WebSearchTool 让模型可以搜索互联网获取最新信息。原始实现仅支持 Anthropic API 服务端搜索（`web_search_20250305` server tool），在第三方代理端点下不可用。现已重构为适配器架构，支持 API 服务端搜索，以及 Bing / Brave 两个 HTML 解析后端，确保任何 API 端点都能使用搜索功能。

## 二、实现架构

### 2.1 适配器模式

```
WebSearchTool.call()
       │
       ▼
  createAdapter()  ← 适配器工厂
       │
       ├── ApiSearchAdapter  — Anthropic 官方 API 服务端搜索
       │     └── 使用 web_search_20250305 server tool
       │         通过 queryModelWithStreaming 二次调用 API
       │
       ├── BingSearchAdapter  — Bing HTML 抓取 + 正则提取
       │     └── 直接抓取 Bing 搜索页 HTML
       │         正则提取 b_algo 块中的标题/URL/摘要
       │
       └── BraveSearchAdapter — Brave LLM Context API
             └── 调用 Brave HTTPS GET 接口
                 将 grounding payload 映射为标题/URL/摘要
```

### 2.2 模块结构

| 模块 | 文件 | 说明 |
|------|------|------|
| 工具入口 | `packages/builtin-tools/src/tools/WebSearchTool/WebSearchTool.ts` | `buildTool()` 定义：schema、权限、执行、输出格式化 |
| 工具 prompt | `packages/builtin-tools/src/tools/WebSearchTool/prompt.ts` | 搜索工具的系统提示词 |
| UI 渲染 | `packages/builtin-tools/src/tools/WebSearchTool/UI.tsx` | 搜索结果的终端渲染组件 |
| 适配器接口 | `packages/builtin-tools/src/tools/WebSearchTool/adapters/types.ts` | `WebSearchAdapter` 接口、`SearchResult`/`SearchOptions`/`SearchProgress` 类型 |
| 适配器工厂 | `packages/builtin-tools/src/tools/WebSearchTool/adapters/index.ts` | `createAdapter()` 工厂函数，选择后端 |
| API 适配器 | `packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts` | 封装原有 `queryModelWithStreaming` 逻辑，使用 server tool |
| Bing 适配器 | `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts` | Bing HTML 抓取 + 正则解析 |
| Brave 适配器 | `packages/builtin-tools/src/tools/WebSearchTool/adapters/braveAdapter.ts` | Brave LLM Context API 适配与结果映射 |
| 单元测试 | `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.test.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/braveAdapter*.test.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/adapterFactory.test.ts` | Bing / Brave 解析与工厂逻辑测试 |
| 集成测试 | `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.integration.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/braveAdapter.integration.ts` | 真实网络请求验证 |

### 2.3 数据流

```
模型调用 WebSearchTool(query, allowed_domains, blocked_domains)
       │
       ▼
  validateInput() — 校验 query 非空、allowed/block 不共存
       │
       ▼
  createAdapter() → ApiSearchAdapter | BingSearchAdapter | BraveSearchAdapter
       │
       ▼
  adapter.search(query, { allowedDomains, blockedDomains, signal, onProgress })
       │
       ├── onProgress({ type: 'query_update', query })
       │
       ├── axios.get(search-engine-url)
       │     └── API 鉴权请求头
       │
       ├── extractResults(payload) — 按后端提取结果
       │     └── grounding → SearchResult[] 映射
       │
       ├── 客户端域名过滤 (allowedDomains / blockedDomains)
       │
       ├── onProgress({ type: 'search_results_received', resultCount })
       │
       ▼
  格式化为 markdown 链接列表返回给模型
```

## 三、Bing 适配器技术细节

### 3.1 反爬绕过

使用 13 个 Edge 浏览器请求头（含 `Sec-Ch-Ua`、`Sec-Fetch-*` 等），避免 Bing 返回 JS 渲染的空页面：

```typescript
const BROWSER_HEADERS = {
  'User-Agent': '...Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Sec-Ch-Ua': '"Microsoft Edge";v="131", "Chromium";v="131", ...',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  // ... 共 13 个标头
}
```

`setmkt=en-US` 参数强制美式英语市场，避免 IP 地理定位导致区域化结果。

### 3.2 URL 解码（`resolveBingUrl()`）

Bing 返回的重定向 URL 格式：`bing.com/ck/a?...&u=a1aHR0cHM6Ly9...`

- `u` 参数前 2 字符为协议前缀：`a1` = https，`a0` = http
- 剩余部分为 base64url 编码的真实 URL
- Bing 内部链接和相对路径被过滤返回 `undefined`

### 3.3 摘要提取（`extractSnippet()`）

三级降级策略：

1. `<p class="b_lineclamp...">` — Bing 的搜索摘要段落
2. `<div class="b_caption">` 内的 `<p>` — 备选摘要位置
3. `<div class="b_caption">` 直接文本 — 最终 fallback

### 3.4 域名过滤

客户端侧实现，支持子域名匹配：
- `allowedDomains`：白名单，结果域名必须匹配列表中的某项（含子域名）
- `blockedDomains`：黑名单，匹配的结果被过滤
- 两者不可同时使用（`validateInput` 校验）

## 四、搜索源与聚合

默认不是「选一个后端」，而是**并行跑所有已连接的搜索源，合并成一份结果**。

### 4.1 四个对称源（`adapters/searchSources.ts`）

| 源 | 执行 | 凭据 |
|---|---|---|
| `anthropic` | Anthropic server-side `web_search_20250305` | Claude OAuth 或 `ANTHROPIC_API_KEY` |
| `gemini` | Gemini `generateContent` + `googleSearch` grounding | Google(Antigravity) OAuth 或 `GEMINI_API_KEY` |
| `codex` | OpenAI Responses API 内建 `web_search` 工具 | ChatGPT OAuth 或 `OPENAI_API_KEY` |
| `free` | 免密钥多引擎抓取（移植自 sweetcornna/free-search-mcp） | 无 |

**有凭据即默认开**：settings 只存用户的显式改动（`webSearchSources.<id>`），没动过的源跟随凭据。
面板在 `/search-setting`（勾选、登录、断开）。

### 4.2 聚合规则（`adapters/aggregateAdapter.ts`）

- 当前主循环 provider 对应的那个源是**主路**，结果排在最前；其余启用的源是**增强路**，
  只补主路没有的 URL。同一家凭据只发一路（主循环是 Gemini 就不再发 gemini 增强路）。
- 全部并行发起。主路返回后增强路只有一小段宽限期（`ENHANCER_GRACE_MS`，2s），超时即丢弃——
  慢抓取最多让用户多等 2 秒，不会拖垮整次搜索。
- 主路失败或为空时，增强路会被**完整等待**（没有可增强的东西时它们就是答案）。
- 单路失败静默；**所有路都失败**才把错误抛给工具。
- 去重按归一化 URL（去 fragment、去 utm/gclid 等跟踪参数、去末尾斜杠），总数封顶 `num_results`（默认 8）。
- Gemini 的 grounding URL 是 `vertexaisearch.cloud.google.com/grounding-api-redirect/…` 重定向壳，
  先用 HEAD 跟随解析出真实 URL 再参与去重与域名过滤。

**主路 / 增强路不只是排序，它决定了请求怎么发**，三个源各有一套：

| 源 | 主路 | 增强路 |
| --- | --- | --- |
| `anthropic` | 走会话自己的 query 管线（`ApiSearchAdapter`） | 独立的 Messages 调用（`AnthropicDirectSearchAdapter`）——管线会把请求路由到当前 provider，增强路不能用它 |
| `gemini` | 按 `GEMINI_AUTH_MODE` 决定公网端点还是 Antigravity | 只要有 Google 登录就走 Antigravity |
| `codex` | 按 `OPENAI_AUTH_MODE` 决定 API key 还是 ChatGPT OAuth | 优先用已连接的 ChatGPT 账号，没有登录才回落 API key |

**Gemini 的模型必须跟着路由走**：Antigravity 后端只服务它自己的模型 id（`gemini-3.1-pro-low` /
`gemini-3.1-flash-lite` / `gemini-pro-agent`），公网 id 一律回 404 `Requested entity was not found`。
搜索 lane 因此按路由挑默认模型（Antigravity 用 flash-lite，公网用 `gemini-2.5-flash`），
且**不会**把一个公网 `GEMINI_MODEL` 原样转发到 Antigravity。

### 4.3 显式点名（跳过聚合）

`WEB_SEARCH_ADAPTER` 环境变量 > `settings.webSearchAdapter`，取值
`api|codex|gemini|free|bing|brave|exa`，命中时**只跑这一个源**。
不认识的值（例如已删除的 `tavily`）静默回落到默认聚合。

点名一个源**不会**让它变成会话的 provider——`api`/`gemini`/`codex` 仍按 4.2 的表判定主路还是增强路。

`brave` 需要 `BRAVE_SEARCH_API_KEY` 或 `BRAVE_API_KEY`；`exa` 可配 `exaApiKey`。

## 五、接口定义

### WebSearchAdapter

```typescript
interface WebSearchAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>
}

interface SearchResult {
  title: string
  url: string
  snippet?: string
}

interface SearchOptions {
  allowedDomains?: string[]
  blockedDomains?: string[]
  signal?: AbortSignal
  onProgress?: (progress: SearchProgress) => void
}

interface SearchProgress {
  type: 'query_update' | 'search_results_received'
  query?: string
  resultCount?: number
}
```

### 工具 Input Schema

```typescript
{
  query: string              // 搜索关键词，最少 2 字符
  allowed_domains?: string[] // 域名白名单
  blocked_domains?: string[] // 域名黑名单
}
```

## 六、文件索引

| 文件 | 职责 |
|------|------|
| `packages/builtin-tools/src/tools/WebSearchTool/WebSearchTool.ts` | 工具定义入口 |
| `packages/builtin-tools/src/tools/WebSearchTool/prompt.ts` | 搜索工具 prompt |
| `packages/builtin-tools/src/tools/WebSearchTool/UI.tsx` | 终端 UI 渲染 |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/types.ts` | 适配器接口 |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/index.ts` | 适配器工厂 |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts` | API 服务端搜索适配器 |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts` | Bing HTML 解析适配器 |
| `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.test.ts` | 单元测试 (32 cases) |
| `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.integration.ts` | 集成测试 |
| `src/tools.ts` | 工具注册 |
