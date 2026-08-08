<!-- lang-switcher -->
**English** · [中文](/docs/zh/external-dependencies) · [日本語](/docs/ja/external-dependencies)

# Claude Code Remote Service Dependencies

> This document lists only remote services to which the code actually sends network requests. It excludes local services, npm package dependencies, and URLs used only for display.

## Summary

| # | Service | Remote endpoint | Protocol | Status |
|---|---|---|---|---|
| 1 | Anthropic API | `api.anthropic.com` | HTTPS | Enabled by default |
| 2 | AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | HTTPS | Requires `CLAUDE_CODE_USE_BEDROCK=1` |
| 3 | Google Vertex AI | `{region}-aiplatform.googleapis.com` | HTTPS | Requires `CLAUDE_CODE_USE_VERTEX=1` |
| 4 | Azure Foundry | `{resource}.services.ai.azure.com` | HTTPS | Requires `CLAUDE_CODE_USE_FOUNDRY=1` |
| 5 | OAuth (Anthropic) | `platform.claude.com`, `claude.com`, `claude.ai` | HTTPS | During user sign-in |
| 6 | GrowthBook | `api.anthropic.com` (remoteEval) | HTTPS | Enabled by default |
| 7 | Sentry | Configurable (`SENTRY_DSN`) | HTTPS | Requires an environment variable |
| 8 | Datadog | Configurable (`DATADOG_LOGS_ENDPOINT`) | HTTPS | Requires an environment variable |
| 9 | OpenTelemetry Collector | Configurable (`OTEL_EXPORTER_OTLP_ENDPOINT`) | gRPC/HTTP | Requires an environment variable |
| 10 | 1P Event Logging | `api.anthropic.com/api/event_logging/batch` | HTTPS | Enabled by default |
| 11 | BigQuery Metrics | `api.anthropic.com/api/claude_code/metrics` | HTTPS | Enabled by default |
| 12 | MCP Proxy | `mcp-proxy.anthropic.com` | HTTPS+WS | When using MCP tools |
| 13 | MCP Registry | `api.anthropic.com/mcp-registry` | HTTPS | When querying MCP servers |
| 14 | Web Search Pages | `html.duckduckgo.com`, `www.mojeek.com`, `www4.bing.com`, public SearXNG instances, `www.bing.com`, `search.brave.com` | HTTPS | The `free` WebSearch source participates in aggregation by default; `bing`/`brave` must be selected explicitly through `WEB_SEARCH_ADAPTER` |
| 15 | Google Cloud Storage (updates) | `storage.googleapis.com` | HTTPS | Version checks |
| 16 | GitHub Raw (Changelog/Stats) | `raw.githubusercontent.com` | HTTPS | Update notices |
| 17 | CCR Upstream Proxy | `api.anthropic.com` | WS | CCR remote sessions |
| 18 | Voice STT | `api.anthropic.com/api/ws/...` | WSS | Voice Mode |
| 19 | Desktop App Download | `claude.ai/api/desktop/...` | HTTPS | Download guidance |

---

## Details

### 1. Anthropic Messages API

The core LLM inference service. It sends conversation messages and receives streaming responses.

- **Endpoint**: `https://api.anthropic.com` (production) / `https://api-staging.anthropic.com` (staging)
- **Override**: `ANTHROPIC_BASE_URL` environment variable
- **Authentication**: API Key / OAuth Token
- **Files**: `src/services/api/client.ts`, `src/services/api/claude.ts`

### 2. AWS Bedrock

- **Endpoint**: `bedrock-runtime.{region}.amazonaws.com`
- **Authentication**: AWS credential chain / `AWS_BEARER_TOKEN_BEDROCK`
- **Files**: `src/services/api/client.ts:153-190`, `src/utils/aws.ts`

### 3. Google Vertex AI

- **Endpoint**: `{region}-aiplatform.googleapis.com`
- **Authentication**: `GoogleAuth` + `cloud-platform` scope
- **File**: `src/services/api/client.ts:221-298`

### 4. Azure Foundry

- **Endpoint**: `https://{resource}.services.ai.azure.com/anthropic/v1/messages`
- **Authentication**: API Key or Azure AD `DefaultAzureCredential`
- **File**: `src/services/api/client.ts:191-220`

### 5. OAuth

OAuth 2.0 + PKCE authorization code flow.

- **Endpoints**:
  - `https://platform.claude.com/oauth/authorize` — Authorization page
  - `https://claude.com/cai/oauth/authorize` — Claude.ai authorization
  - `https://platform.claude.com/v1/oauth/token` — Token exchange
  - `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` — API Key creation
  - `https://api.anthropic.com/api/oauth/claude_cli/roles` — Role retrieval
  - `https://claude.ai/oauth/claude-code-client-metadata` — MCP client metadata
  - `https://claude.fedstart.com` — FedStart government deployment
- **Files**: `src/constants/oauth.ts`, `src/services/oauth/`

### 6. GrowthBook (Feature Flags)

- **Endpoint**: `https://api.anthropic.com/` (remoteEval mode) or `CLAUDE_GB_ADAPTER_URL`
- **SDK Keys**: `sdk-zAZezfDKGoZuXXKe` (external), `sdk-xRVcrliHIlrg4og4` (ant prod), `sdk-yZQvlplybuXjYh6L` (ant dev)
- **Files**: `src/services/analytics/growthbook.ts`, `src/constants/keys.ts`

### 7. Sentry (Error Tracking)

- **Activation**: Set `SENTRY_DSN` (not configured by default)
- **Behavior**: Reports errors only and automatically filters sensitive headers
- **File**: `src/utils/sentry.ts`

### 8. Datadog (Logging)

- **Activation**: Set both `DATADOG_LOGS_ENDPOINT` + `DATADOG_API_KEY` (not configured by default)
- **File**: `src/services/analytics/datadog.ts`

### 9. OpenTelemetry Collector

- **Activation**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` or `OTEL_*` environment variables
- **Protocol**: gRPC / HTTP / Protobuf, with OTLP and Prometheus export support
- **File**: `src/utils/telemetry/instrumentation.ts`

### 10. 1P Event Logging (Internal Events)

- **Endpoint**: `https://api.anthropic.com/api/event_logging/batch`
- **Protocol**: Batch export (10s interval, 200 events per batch)
- **File**: `src/services/analytics/firstPartyEventLoggingExporter.ts`

### 11. BigQuery Metrics

- **Endpoint**: `https://api.anthropic.com/api/claude_code/metrics`
- **File**: `src/utils/telemetry/bigqueryExporter.ts`

### 12. MCP Proxy

An Anthropic-hosted proxy for MCP servers.

- **Endpoint**: `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}`
- **Authentication**: Claude.ai OAuth tokens
- **Files**: `src/services/mcp/client.ts`, `src/constants/oauth.ts`

### 13. MCP Registry

Retrieves the list of official MCP servers.

- **Endpoint**: `https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial`
- **File**: `src/services/mcp/officialRegistry.ts`

### 14. Web Search Pages

By default, WebSearch aggregates multiple search sources. The `free` source (which requires no key and participates by default) fetches search result pages directly;
`bing`/`brave` are used only when explicitly selected through `WEB_SEARCH_ADAPTER`.

- **Engines for the free source** (parallel + RRF fusion):
  - `https://html.duckduckgo.com/html/?q={query}`
  - `https://www.mojeek.com/search?q={query}`
  - `https://www4.bing.com/search?q={query}` (the www version challenges headless clients; www4 does not)
  - Fallback: public SearXNG instances (probed only when all three sources above are empty or fail)
- **Bing endpoint** (`WEB_SEARCH_ADAPTER=bing`): `https://www.bing.com/search?q={query}&setmkt=en-US`
- **Brave endpoint** (`WEB_SEARCH_ADAPTER=brave`): `https://api.search.brave.com/res/v1/llm/context?q={query}`
- **Gemini grounding redirect resolution**: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/...`
  (sends a HEAD request and resolves the publisher's actual URL)
- **Files**:
  - `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts`
  - `packages/builtin-tools/src/tools/WebSearchTool/adapters/braveAdapter.ts`

There is also a Domain Blocklist query:
- **Endpoint**: `https://api.anthropic.com/api/web/domain_info?domain={domain}`
- **File**: `packages/builtin-tools/src/tools/WebFetchTool/utils.ts`

### 15. Google Cloud Storage (Automatic Updates)

- **Endpoint**: `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases`
- **File**: `src/utils/autoUpdater.ts`

### 16. GitHub Raw Content

- **Endpoint**: `https://raw.githubusercontent.com/sweetcornna/open-claude-code/refs/heads/main/CHANGELOG.md` (occ's own release notes; `bun run release` writes them and pushes them to main with the release commit)
- **Endpoint**: `https://raw.githubusercontent.com/anthropics/claude-plugins-official/refs/heads/stats/stats/plugin-installs.json`
- **Files**: `src/utils/update/releaseNotes.ts`, `src/utils/plugins/installCounts.ts`

### 17. CCR Upstream Proxy

- **Endpoint**: `ws://api.anthropic.com/v1/code/upstreamproxy/ws`
- **Activation**: `CLAUDE_CODE_REMOTE=1` + `CCR_UPSTREAM_PROXY_ENABLED=1`
- **File**: `src/upstreamproxy/upstreamproxy.ts`

### 18. Voice STT

- **Endpoint**: `wss://api.anthropic.com/api/ws/...`
- **File**: `src/services/voiceStreamSTT.ts`

### 19. Desktop App Download

- **Endpoint**: `https://claude.ai/api/desktop/win32/x64/exe/latest/redirect` (Windows)
- **Endpoint**: `https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect` (macOS)
- **File**: `src/components/DesktopHandoff.tsx`

---

## Anthropic API Auxiliary Endpoint Summary

All endpoints below are hosted on `api.anthropic.com` and grouped by function:

| Endpoint path | Purpose | File |
|---|---|---|
| `/api/event_logging/batch` | Batch event reporting | `src/services/analytics/firstPartyEventLoggingExporter.ts` |
| `/api/claude_code/metrics` | BigQuery metrics export | `src/utils/telemetry/bigqueryExporter.ts` |
| `/api/oauth/claude_cli/create_api_key` | Create an API Key | `src/constants/oauth.ts` |
| `/api/oauth/claude_cli/roles` | Retrieve user roles | `src/constants/oauth.ts` |
| `/api/oauth/accounts/grove` | Notification settings | `src/services/api/grove.ts` |
| `/api/oauth/organizations/{id}/referral/*` | Referral campaigns | `src/services/api/referral.ts` |
| `/api/oauth/organizations/{id}/overage_credit_grant` | Overage credit | `src/services/api/overageCreditGrant.ts` |
| `/api/oauth/organizations/{id}/admin_requests` | Administrative requests | `src/services/api/adminRequests.ts` |
| `/api/web/domain_info?domain={}` | Domain security check | `src/tools/WebFetchTool/utils.ts` |
| `/api/claude_code/settings` | Settings synchronization | `src/services/settingsSync/index.ts` |
| `/api/claude_code/managed_settings` | Enterprise managed settings (1h polling) | `src/services/remoteManagedSettings/index.ts` |
| `/api/auth/trusted_devices` | Trusted-device registration | `src/bridge/trustedDevice.ts` |
| `/mcp-registry/v0/servers` | MCP server registry | `src/services/mcp/officialRegistry.ts` |
| `/v1/files` | File upload/download | `src/services/api/filesApi.ts` |
| `/v1/sessions/{id}/events` | Session history | `src/assistant/sessionHistory.ts` |
| `/v1/code/triggers` | Remote triggers | `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts` |
| `/v1/organizations/{id}/mcp_servers` | Organization MCP configuration | `src/services/mcp/claudeai.ts` |

## Non-Anthropic Remote Domain Summary

| Domain | Service | Protocol |
|---|---|---|
| `bedrock-runtime.*.amazonaws.com` | AWS Bedrock | HTTPS |
| `{region}-aiplatform.googleapis.com` | Google Vertex AI | HTTPS |
| `{resource}.services.ai.azure.com` | Azure Foundry | HTTPS |
| `www.bing.com` | Bing Search | HTTPS |
| `search.brave.com` | Brave Search | HTTPS |
| `storage.googleapis.com` | Automatic Updates | HTTPS |
| `raw.githubusercontent.com` | Changelog / Plugin Statistics | HTTPS |
| `platform.claude.com` | OAuth Authorization Page | HTTPS |
| `claude.com` / `claude.ai` | OAuth / Download | HTTPS |
| `claude.fedstart.com` | FedStart OAuth | HTTPS |
