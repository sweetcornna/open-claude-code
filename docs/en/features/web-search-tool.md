<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/web-search-tool) · [日本語](/docs/ja/features/web-search-tool)

# WEB_SEARCH_TOOL — Web Search Tool

> Implementation status: Adapter architecture complete; supports API, Bing, and Brave backends
> Reference count: Core tool; no feature-flag gate (always enabled)

## 1. Feature overview

WebSearchTool allows the model to search the internet for current information. The original implementation supported only Anthropic API server-side search (the `web_search_20250305` server tool), which was unavailable through third-party proxy endpoints. The tool now uses an adapter architecture that supports API server-side search plus Bing and Brave HTML-parsing backends, making search available with any API endpoint.

## 2. Implementation architecture

### 2.1 Adapter pattern

```
WebSearchTool.call()
       │
       ▼
  createAdapter()  ← adapter factory
       │
       ├── ApiSearchAdapter  — official Anthropic API server-side search
       │     └── uses the web_search_20250305 server tool
       │         makes a second API call through queryModelWithStreaming
       │
       ├── BingSearchAdapter  — Bing HTML fetch + regular-expression extraction
       │     └── fetches the Bing search-results HTML directly
       │         extracts title/URL/snippet from b_algo blocks with regular expressions
       │
       └── BraveSearchAdapter — Brave LLM Context API
             └── calls the Brave HTTPS GET endpoint
                 maps the grounding payload to title/URL/snippet
```

### 2.2 Module structure

| Module | File | Description |
|------|------|------|
| Tool entry point | `packages/builtin-tools/src/tools/WebSearchTool/WebSearchTool.ts` | `buildTool()` definition: schema, permissions, execution, and output formatting |
| Tool prompt | `packages/builtin-tools/src/tools/WebSearchTool/prompt.ts` | System prompt for the search tool |
| UI rendering | `packages/builtin-tools/src/tools/WebSearchTool/UI.tsx` | Terminal rendering component for search results |
| Adapter interface | `packages/builtin-tools/src/tools/WebSearchTool/adapters/types.ts` | `WebSearchAdapter` interface and `SearchResult`/`SearchOptions`/`SearchProgress` types |
| Adapter factory | `packages/builtin-tools/src/tools/WebSearchTool/adapters/index.ts` | `createAdapter()` factory function that selects a backend |
| API adapter | `packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts` | Wraps the original `queryModelWithStreaming` logic and uses the server tool |
| Bing adapter | `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts` | Bing HTML fetching and regular-expression parsing |
| Brave adapter | `packages/builtin-tools/src/tools/WebSearchTool/adapters/braveAdapter.ts` | Brave LLM Context API adaptation and result mapping |
| Unit tests | `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.test.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/braveAdapter*.test.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/adapterFactory.test.ts` | Tests for Bing/Brave parsing and factory logic |
| Integration tests | `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.integration.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/braveAdapter.integration.ts` | Verification with real network requests |

### 2.3 Data flow

```
Model invokes WebSearchTool(query, allowed_domains, blocked_domains)
       │
       ▼
  validateInput() — verify query is nonempty and allow/block are not both set
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
       │     └── API authentication headers
       │
       ├── extractResults(payload) — extract results for the selected backend
       │     └── grounding → SearchResult[] mapping
       │
       ├── Client-side domain filtering (allowedDomains / blockedDomains)
       │
       ├── onProgress({ type: 'search_results_received', resultCount })
       │
       ▼
  Format as a Markdown link list and return it to the model
```

## 3. Bing adapter technical details

### 3.1 Anti-bot bypass

The adapter sends 13 Edge browser request headers (including `Sec-Ch-Ua`, `Sec-Fetch-*`, and others) to prevent Bing from returning an empty page that requires JavaScript rendering:

```typescript
const BROWSER_HEADERS = {
  'User-Agent': '...Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Sec-Ch-Ua': '"Microsoft Edge";v="131", "Chromium";v="131", ...',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  // ... 13 headers in total
}
```

The `setmkt=en-US` parameter forces the US English market, preventing IP geolocation from producing localized results.

### 3.2 URL decoding (`resolveBingUrl()`)

Bing returns redirect URLs in this form: `bing.com/ck/a?...&u=a1aHR0cHM6Ly9...`

- The first two characters of the `u` parameter are a protocol prefix: `a1` = https, `a0` = http
- The remainder is the real URL encoded as base64url
- Bing-internal links and relative paths are filtered out by returning `undefined`

### 3.3 Snippet extraction (`extractSnippet()`)

Three-stage degradation strategy:

1. `<p class="b_lineclamp...">` — Bing's search-snippet paragraph
2. `<p>` inside `<div class="b_caption">` — alternate snippet location
3. Direct text from `<div class="b_caption">` — final fallback

### 3.4 Domain filtering

Implemented on the client and supports subdomain matching:
- `allowedDomains`: allowlist; a result's domain must match an entry, including subdomains
- `blockedDomains`: denylist; matching results are filtered out
- They cannot be used together (enforced by `validateInput`)

## 4. Search sources and aggregation

By default, the tool does not “select one backend.” It **runs every connected search source in parallel and merges their results**.

### 4.1 Four symmetric sources (`adapters/searchSources.ts`)

| Source | Execution | Credentials |
|---|---|---|
| `anthropic` | Anthropic server-side `web_search_20250305` | Claude OAuth or `ANTHROPIC_API_KEY` |
| `gemini` | Gemini `generateContent` with `googleSearch` grounding | Google (Antigravity) OAuth or `GEMINI_API_KEY` |
| `codex` | Built-in `web_search` tool in the OpenAI Responses API | ChatGPT OAuth or `OPENAI_API_KEY` |
| `free` | Keyless multi-engine fetching (ported from sweetcornna/free-search-mcp) | None |

**Credentials enable a source by default**: settings store only the user's explicit changes (`webSearchSources.<id>`); untouched sources follow credential availability.
The panel is available at `/search-setting` for enabling, signing in, and disconnecting sources.

### 4.2 Aggregation rules (`adapters/aggregateAdapter.ts`)

- The source corresponding to the current main-loop provider is the **primary lane**, and its results appear first. Other enabled sources are **enhancement lanes**
  and contribute only URLs absent from the primary lane. A credential family sends only one lane (if the main loop uses Gemini, it does not also send a Gemini enhancement lane).
- All lanes start in parallel. After the primary lane returns, enhancement lanes receive only a short grace period (`ENHANCER_GRACE_MS`, 2s); results that time out are discarded.
  Slow fetching can delay the user by at most 2 seconds instead of delaying the entire search.
- If the primary lane fails or returns no results, the tool **waits fully** for enhancement lanes because, with nothing to enhance, they become the answer.
- A single-lane failure is silent; the tool throws an error only when **every lane fails**.
- Results are deduplicated by normalized URL (remove fragments, tracking parameters such as utm/gclid, and trailing slashes), and the total is capped at `num_results` (8 by default).
- Gemini grounding URLs are redirect wrappers under `vertexaisearch.cloud.google.com/grounding-api-redirect/…`.
  The tool first follows them with HEAD to resolve the real URL, then applies deduplication and domain filtering.

**Primary and enhancement lanes determine more than ordering; they determine how requests are sent.** Each of the three sources has its own behavior:

| Source | Primary lane | Enhancement lane |
| --- | --- | --- |
| `anthropic` | Uses the session's query pipeline (`ApiSearchAdapter`) | Makes an independent Messages call (`AnthropicDirectSearchAdapter`); the pipeline routes requests to the current provider, so the enhancement lane cannot use it |
| `gemini` | Selects the public endpoint or Antigravity according to `GEMINI_AUTH_MODE` | Uses Antigravity whenever a Google login is available |
| `codex` | Selects an API key or ChatGPT OAuth according to `OPENAI_AUTH_MODE` | Prefers a connected ChatGPT account and falls back to the API key only when no account is signed in |

**The Gemini model must follow the route**: the Antigravity backend serves only its own model IDs (`gemini-3.1-pro-low` /
`gemini-3.1-flash-lite` / `gemini-pro-agent`); public IDs always return 404 `Requested entity was not found`.
The search lane therefore selects a default model by route (flash-lite for Antigravity, `gemini-2.5-flash` for the public endpoint)
and **does not** forward a public `GEMINI_MODEL` value unchanged to Antigravity.

### 4.3 Explicit selection (skip aggregation)

The `WEB_SEARCH_ADAPTER` environment variable takes precedence over `settings.webSearchAdapter`. Valid values are
`api|codex|gemini|free|bing|brave|exa`; when a value matches, the tool **runs only that source**.
An unrecognized value (for example, the removed `tavily`) silently falls back to default aggregation.

Naming a source explicitly **does not** make it the session's provider. `api`/`gemini`/`codex` still determine whether they are primary or enhancement lanes according to the table in §4.2.

`brave` requires `BRAVE_SEARCH_API_KEY` or `BRAVE_API_KEY`; `exa` can use `exaApiKey`.

## 5. Interface definitions

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

### Tool input schema

```typescript
{
  query: string              // Search query; at least 2 characters
  allowed_domains?: string[] // Domain allowlist
  blocked_domains?: string[] // Domain denylist
}
```

## 6. File index

| File | Responsibility |
|------|------|
| `packages/builtin-tools/src/tools/WebSearchTool/WebSearchTool.ts` | Tool-definition entry point |
| `packages/builtin-tools/src/tools/WebSearchTool/prompt.ts` | Search-tool prompt |
| `packages/builtin-tools/src/tools/WebSearchTool/UI.tsx` | Terminal UI rendering |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/types.ts` | Adapter interface |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/index.ts` | Adapter factory |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts` | API server-side search adapter |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts` | Bing HTML parsing adapter |
| `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.test.ts` | Unit tests (32 cases) |
| `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.integration.ts` | Integration tests |
| `src/tools.ts` | Tool registration |
