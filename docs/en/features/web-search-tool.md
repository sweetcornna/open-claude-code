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
- **A tracking link written as a relative path (`/ck/a?...&u=a1...`) resolves to the publisher URL too**: the real
  URL lives inside the base64 blob, so whether the href is absolute or relative says nothing about it. Decoding
  runs first and the shape rules apply only to what does not decode — otherwise a whole SERP that emits the
  relative form is discarded wholesale (matching upstream free-search-mcp v0.9.2)
- Bing-internal links and relative/anchor links that carry no decodable target are still filtered out by returning `undefined`

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

### 4.1 Seven symmetric sources (`adapters/searchSources.ts`)

The table order is the panel order and the merge priority for enhancement lanes.

| Source | Execution | Credentials |
|---|---|---|
| `anthropic` | Anthropic server-side `web_search_20250305` | **Pinned credential** > Claude OAuth or `ANTHROPIC_API_KEY` |
| `deepseek` | DeepSeek server-side `web_search_20250305`, over `<base>/anthropic` | **Pinned credential** > a DeepSeek endpoint plus a key (`OPENAI_BASE_URL` pointing at api.deepseek.com) |
| `gemini` | Gemini `generateContent` with `googleSearch` grounding | **Pinned credential** > Google (Antigravity) OAuth or `GEMINI_API_KEY` |
| `codex` | Built-in `web_search` tool in the OpenAI Responses API | ChatGPT OAuth or `OPENAI_API_KEY` (**cannot be pinned**, see §4.1.1) |
| `brave` | Brave LLM Context API (an independent index) | `settings.braveApiKey`, or `BRAVE_SEARCH_API_KEY` / `BRAVE_API_KEY` |
| `exa` | Exa neural search over its MCP endpoint | `settings.exaApiKey` |
| `free` | Keyless multi-engine fetching (ported from sweetcornna/free-search-mcp) | None |

**Credentials enable a source by default**: settings store only the user's explicit changes (`webSearchSources.<id>`); untouched sources follow credential availability.
The panel is available at `/search-setting` for enabling, signing in, and disconnecting sources.

**For `brave` and `exa`, a configured key IS the credential**, with exactly the semantics a login has: no key, no
lane; an explicit "off" always wins; ticking a source with no key cannot manufacture the capability. They are in the
registry rather than being explicit-only picks because, previously, the only way to consult an index the user had
paid for was `WEB_SEARCH_ADAPTER=brave` — which switches **every other source off**. The check asks each adapter
which key it would actually send (`resolveBraveApiKey` / `resolveExaApiKey`), so "the panel says connected" and
"the request carries a key" cannot drift apart.

**`bing` is deliberately NOT in the registry**: it scrapes the same endpoint, from the same IP, that the `free`
lane's own Bing engine already uses, so aggregating it spends one quota twice and doubles the odds of drawing the
CAPTCHA for both. It remains available as an explicit pick (see §4.3).

### 4.1.1 Pinned credentials (`services/search/searchCredentialStore.ts`)

**The problem.** Search credentials used to be entirely parasitic on the main provider configuration: all four
provider sources read `GEMINI_API_KEY` / `OPENAI_API_KEY` + `OPENAI_BASE_URL` / `ANTHROPIC_API_KEY` straight out of
the environment. Those are exactly the keys `/logout` deletes (`LOGOUT_ENV_KEYS`, derived from
`ALL_PROFILE_ENV_KEYS`) and the keys `activateProfile()` clears **wholesale** before applying a target profile — it
wipes the union of every family's keys. So logging out, or merely switching from an OpenAI profile to an OpenCode
one, silently dropped web search to the keyless scraping lane, with nothing said.

**The fix.** `S` in `/search-setting` copies the credential a source is authenticating with **right now** into occ's
own credential file.

| | |
| --- | --- |
| Path | `occConfigPath('search-credentials.json')` — i.e. `~/.occ/search-credentials.json`, moved by `OCC_CONFIG_DIR` |
| Mode | `0600`, written atomically through `writePrivateFileAtomic` |
| Shape | `{ version, sources: { <source>: { apiKey, baseURL?, pinnedAt } } }` — **per source**, not one blob |
| Pinnable | `anthropic`, `deepseek`, `gemini` |

**Resolution order: pinned credential → provider env.** A user who never pins keeps working exactly as before, byte
for byte, with no migration step.

The rules that are not obvious:

- **Not `settings.json`.** That file is the one users paste into bug reports, and it is not 0600.
- **Neither `/logout` nor `activateProfile()` reaches this file** — not because they remember to skip a key, but
  because it is outside anything either of them rewrites. One regression test pins each of those.
- **`/logout` says so.** If anything is still pinned afterwards, the logout message names each source and points at
  `/search-setting` (`D`) to remove it. Keeping rather than silently revoking, because pinning is an explicit
  per-source choice — and a silent revoke would recreate the exact failure the store exists to end.
- **A credential must carry its endpoint**, or the endpoint predicates pass on a key that cannot be used:
  `hasCodexSearchCredentials()` requires `api.openai.com`, and the DeepSeek lane derives its own endpoint
  (`getDeepSeekSearchEndpoint()`, deliberately not gated on the main loop's wire).
- **`CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` still outranks a pin.** That switch names this endpoint specifically; a
  pin says *which credential*, never "override a capability the user switched off".
- **A key is never rendered.** The panel appends `· pinned` to the connected badge — no value, prefix or length.
- **Mirrored values are refused.** `ANTHROPIC_API_KEY` is not always an Anthropic key: the DeepSeek wire mirrors the
  DeepSeek key onto it and an OpenCode session mirrors an hourly OAuth access token there. Detected through the
  mirrors' own bookkeeping (`isDeepSeekMirroredApiKey` / `isOpencodeMirroredApiKey`), never by guessing at shape.
- **`codex` cannot be pinned.** Its lane authenticates inside `createOpenAIResponsesStream`, which builds the request
  from `OPENAI_API_KEY`/`OPENAI_BASE_URL` with no credential seam — a pin would light the row green for a key that
  never leaves disk, which is the "connected source that can only return nothing" the registry exists to prevent.
  Its ChatGPT login is already a 0600 file of occ's own. The read side is uniform across all four families, so
  enabling it later is one line here plus a seam in the request layer.

A pin is genuinely sent, not merely displayed:

| Source | Path taken once pinned |
| --- | --- |
| `anthropic` | `AnthropicDirectSearchAdapter` switches to a standalone `fetch`: `x-api-key` at `<pinned endpoint>/v1/messages`. Not `getAnthropicClient()`, which is assembled from `ANTHROPIC_*` env — after a profile switch those keys can hold another provider's mirrored token and gateway |
| `deepseek` | `resolveDeepSeekSearchEndpoint()` returns the pinned endpoint and key first |
| `gemini` | `streamGeminiGenerateContent({ apiKey, baseURL })`; `usesAntigravityRoute()` stands down for an explicit key, the same rule it already applies to `accessToken` |

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

**Primary and enhancement lanes determine more than ordering; they determine how requests are sent.** Each provider source has its own behavior:

| Source | Primary lane | Enhancement lane |
| --- | --- | --- |
| `anthropic` | Uses the session's query pipeline (`ApiSearchAdapter`) | Makes an independent Messages call (`AnthropicDirectSearchAdapter`); the pipeline routes requests to the current provider, so the enhancement lane cannot use it |
| `deepseek` | The same (the pipeline already points at DeepSeek) | An independent call that resolves the endpoint itself (`DeepSeekDirectSearchAdapter`), so it runs on any wire |
| `gemini` | Selects the public endpoint or Antigravity according to `GEMINI_AUTH_MODE` | Uses Antigravity whenever a Google login is available |
| `codex` | Selects an API key or ChatGPT OAuth according to `OPENAI_AUTH_MODE` | Prefers a connected ChatGPT account and falls back to the API key only when no account is signed in |

`brave`, `exa` and `free` are absent from this table: none of them is any provider's own search layer, so
`primarySourceId()` never names them and they exist only as enhancement lanes — one key, one endpoint, one
construction.

**The Gemini model must follow the route**: the Antigravity backend serves only its own model IDs (`gemini-3.1-pro-low` /
`gemini-3.1-flash-lite` / `gemini-pro-agent`); public IDs always return 404 `Requested entity was not found`.
The search lane therefore selects a default model by route (flash-lite for Antigravity, `gemini-2.5-flash` for the public endpoint)
and **does not** forward a public `GEMINI_MODEL` value unchanged to Antigravity.

### 4.3 Explicit selection (skip aggregation)

The `WEB_SEARCH_ADAPTER` environment variable takes precedence over `settings.webSearchAdapter`. Valid values are
`api|codex|deepseek|gemini|free|bing|brave|exa`; when a value matches, the tool **runs only that source**.
An unrecognized value (for example, the removed `tavily`) silently falls back to default aggregation.

Naming a source explicitly **does not** make it the session's provider. `api`/`gemini`/`codex` still determine whether they are primary or enhancement lanes according to the table in §4.2.

`bing` has no other entry point (it is not in the registry; see §4.1). `brave` and `exa` now join the aggregation
automatically once a key is configured, so naming them explicitly is only useful when you want **that source and
nothing else** — to add one rather than replace the rest, just configure the key.

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
