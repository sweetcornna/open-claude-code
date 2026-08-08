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
- **跟踪链接写成相对路径（`/ck/a?...&u=a1...`）时同样能解出发布者 URL**：真实 URL 在
  base64 块里，跟 href 是绝对还是相对无关。先解码、解不出来再按形状判断，否则一整页
  相对形式的结果会被整体丢弃（对齐上游 free-search-mcp v0.9.2）
- 解不出目标的 Bing 内部链接与相对/锚点链接仍被过滤返回 `undefined`

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

### 4.1 七个对称源（`adapters/searchSources.ts`）

表中顺序 = 面板顺序 = 增强路的合并优先级。

| 源 | 执行 | 凭据 |
|---|---|---|
| `anthropic` | Anthropic server-side `web_search_20250305` | Claude OAuth 或 `ANTHROPIC_API_KEY` |
| `deepseek` | DeepSeek server-side `web_search_20250305`，走 `<base>/anthropic` | DeepSeek 端点 + key（`OPENAI_BASE_URL` 指向 api.deepseek.com） |
| `gemini` | Gemini `generateContent` + `googleSearch` grounding | Google(Antigravity) OAuth 或 `GEMINI_API_KEY` |
| `codex` | OpenAI Responses API 内建 `web_search` 工具 | ChatGPT OAuth 或 `OPENAI_API_KEY` |
| `brave` | Brave LLM Context API（独立索引） | `settings.braveApiKey`，或 `BRAVE_SEARCH_API_KEY` / `BRAVE_API_KEY` |
| `exa` | Exa 神经搜索 MCP 端点 | `settings.exaApiKey` |
| `free` | 免密钥多引擎抓取（移植自 sweetcornna/free-search-mcp） | 无 |

**有凭据即默认开**：settings 只存用户的显式改动（`webSearchSources.<id>`），没动过的源跟随凭据。
面板在 `/search-setting`（勾选、登录、断开、重新探测）。

**`brave` / `exa`：配了 key 就是凭据，语义与登录完全一致** —— 没 key 不点亮，显式关掉永远赢，
勾一个没 key 的源不会凭空造出能力。它们在注册表里而不是只能显式点名，是因为此前用户为一个自己
付过费的索引唯一的用法是 `WEB_SEARCH_ADAPTER=brave`，而那会把**其余所有源一起关掉**。
判据直接问各自适配器「这次请求会带哪把 key」（`resolveBraveApiKey` / `resolveExaApiKey`），
所以面板显示「已连接」和请求真带 key 不可能对不上。

**`bing` 故意不进注册表**：它抓的是 `free` 那一路内部 Bing 引擎的同一个端点、同一个出口 IP，
并进聚合等于把一份配额花两次，并让两路同时撞上 CAPTCHA 的概率翻倍。它仍可显式点名（见 4.3）。

**`deepseek` 为什么是独立的一源，而不是并进 `anthropic`**：DeepSeek 会话的
`getAPIProvider()` 答 `firstParty`，那答的是**协议**，从来不是「谁的模型」。并进去的后果是面板上
出现一行「已连接的 Anthropic」而它的每个字节都发往 api.deepseek.com，并且同一个端点会被当成两家
各发一路。所以 `hasAnthropicSearchCredentials()` 在 DeepSeek 线激活时返回 false，
`primarySourceId()` 返回 `deepseek`。

它也比 `anthropic` 那一源覆盖更宽：这条 lane **不看主循环说什么协议**（和 codex/gemini 增强路
一样），所以 `OPENAI_WIRE_API=chat` 的会话 —— 恰恰是唯一一条**完全没有内建搜索**的协议 —— 也能
用上服务端搜索，而不是掉回免密钥抓取。只有 `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` 会把它整个关掉，
因为那个开关点名的就是这个端点。

**自动探测**：有 DeepSeek key ≠ 那个部署实现了 `web_search_20250305`（自建镜像、老网关会收下 key 然后
拒掉工具）。`probeDeepSeekSearchSupport()` 发一个 `max_tokens: 16` 的最小请求问端点认不认这个工具 ——
只问「收不收」，不真跑一次搜索（那要花掉用户一次搜索的 token 和秒数）。答不认就通过既有的
**会话级 availability 轴**把这一源退役（和一次真实搜索失败走的是同一条路），面板上灰掉并显示端点原话。
`supported`/`unsupported` 按端点缓存，`unreachable`（401/429/5xx/断网）**不缓存也不退役** ——
那些回答与「支不支持搜索」无关，为一次网络抖动把 lane 关掉一整个会话是不对的。

### 4.1.1 面板按键

| 键 | 作用 |
| --- | --- |
| `↑` `↓` | 移动 |
| `Space` | 勾选 / 取消勾选（只影响这一路进不进聚合） |
| `Enter` | 未连接的 OAuth 源 → 开始登录；其余同 Space |
| `D` | **断开**：删掉本面板自己存的凭据（gemini 的 Antigravity token、codex 的 ChatGPT auth） |
| `R` | **重新探测**：清掉本会话的 availability 退役标记和 DeepSeek 探测缓存，全部重查 |
| `Esc` | 有操作在飞 → **取消它**；否则关闭面板 |

三条不显然的规则：

- **`D` 不碰 `anthropic` / `deepseek`**。这两家的凭据就是会话自己的 provider 登录，从搜索设置面板里
  把用户登出整个 CLI 是越权。想让它们不参与聚合用 `Space`，想登出用 `/logout`。
- **断开后仍可能显示已连接，面板会说明为什么**：`removeChatGPTAuth()` 只删 occ 自己那份，
  `~/.codex/auth.json` 是 Codex CLI 的、不归我们删；`GEMINI_API_KEY` 是用户的环境变量。
- **`R` 存在是因为「登录了也用不了」是真实形态**：某个源在本会话早些时候失败过一次就被退役了，
  用户随后修好了根因（登录、换 base URL），但那个标记不会自己消失，界面上就一直是灰的直到重启。
  登录成功和断开成功也都会顺手清一次。

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

**主路 / 增强路不只是排序，它决定了请求怎么发**，四个 provider 源各有一套：

| 源 | 主路 | 增强路 |
| --- | --- | --- |
| `anthropic` | 走会话自己的 query 管线（`ApiSearchAdapter`） | 独立的 Messages 调用（`AnthropicDirectSearchAdapter`）——管线会把请求路由到当前 provider，增强路不能用它 |
| `deepseek` | 同上（管线本来就指着 DeepSeek） | 自己解析端点的独立调用（`DeepSeekDirectSearchAdapter`），所以任何一条线上都能跑 |
| `gemini` | 按 `GEMINI_AUTH_MODE` 决定公网端点还是 Antigravity | 只要有 Google 登录就走 Antigravity |
| `codex` | 按 `OPENAI_AUTH_MODE` 决定 API key 还是 ChatGPT OAuth | 优先用已连接的 ChatGPT 账号，没有登录才回落 API key |

`brave` / `exa` / `free` 不参与这张表：它们不是任何 provider 自己的搜索层，`primarySourceId()`
永远不会点到它们，所以只有增强路一种形态，一把 key、一个端点、一种构造。

**Gemini 的模型必须跟着路由走**：Antigravity 后端只服务它自己的模型 id（`gemini-3.1-pro-low` /
`gemini-3.1-flash-lite` / `gemini-pro-agent`），公网 id 一律回 404 `Requested entity was not found`。
搜索 lane 因此按路由挑默认模型（Antigravity 用 flash-lite，公网用 `gemini-2.5-flash`），
且**不会**把一个公网 `GEMINI_MODEL` 原样转发到 Antigravity。

### 4.3 显式点名（跳过聚合）

`WEB_SEARCH_ADAPTER` 环境变量 > `settings.webSearchAdapter`，取值
`api|codex|deepseek|gemini|free|bing|brave|exa`，命中时**只跑这一个源**。
不认识的值（例如已删除的 `tavily`）静默回落到默认聚合。

点名一个源**不会**让它变成会话的 provider——`api`/`gemini`/`codex` 仍按 4.2 的表判定主路还是增强路。

`bing` 只有这一条入口（不进注册表，理由见 4.1）。`brave` 与 `exa` 现在配了 key 就会自动参与
聚合，所以点名它们的唯一用途是**只要这一个源**——想加入而不是取代，直接配 key 即可。

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
