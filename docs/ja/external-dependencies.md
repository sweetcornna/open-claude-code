<!-- lang-switcher -->
[English](/docs/en/external-dependencies) · [中文](/docs/zh/external-dependencies) · **日本語**

# Claude Code のリモートサーバー依存関係

> コードから実際にネットワークリクエストを送るリモートサービスのみを掲載します。ローカルサービス、npm パッケージの依存関係、表示例の URL は含みません。

## 一覧

| # | サービス | リモートエンドポイント | プロトコル | 状態 |
|---|---|---|---|---|
| 1 | Anthropic API | `api.anthropic.com` | HTTPS | デフォルトで有効 |
| 2 | AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | HTTPS | `CLAUDE_CODE_USE_BEDROCK=1` が必要 |
| 3 | Google Vertex AI | `{region}-aiplatform.googleapis.com` | HTTPS | `CLAUDE_CODE_USE_VERTEX=1` が必要 |
| 4 | Azure Foundry | `{resource}.services.ai.azure.com` | HTTPS | `CLAUDE_CODE_USE_FOUNDRY=1` が必要 |
| 5 | OAuth (Anthropic) | `platform.claude.com`, `claude.com`, `claude.ai` | HTTPS | ユーザーのログイン時 |
| 6 | GrowthBook | `api.anthropic.com` (remoteEval) | HTTPS | デフォルトで有効 |
| 7 | Sentry | 設定可能 (`SENTRY_DSN`) | HTTPS | 環境変数の設定が必要 |
| 8 | Datadog | 設定可能 (`DATADOG_LOGS_ENDPOINT`) | HTTPS | 環境変数の設定が必要 |
| 9 | OpenTelemetry Collector | 設定可能 (`OTEL_EXPORTER_OTLP_ENDPOINT`) | gRPC/HTTP | 環境変数の設定が必要 |
| 10 | 1P Event Logging | `api.anthropic.com/api/event_logging/batch` | HTTPS | デフォルトで有効 |
| 11 | BigQuery Metrics | `api.anthropic.com/api/claude_code/metrics` | HTTPS | デフォルトで有効 |
| 12 | MCP Proxy | `mcp-proxy.anthropic.com` | HTTPS+WS | MCP ツールの使用時 |
| 13 | MCP Registry | `api.anthropic.com/mcp-registry` | HTTPS | MCP サーバーの照会時 |
| 14 | Web Search Pages | `html.duckduckgo.com`, `www.mojeek.com`, `www4.bing.com`, 公開 SearXNG インスタンス, `www.bing.com`, `search.brave.com` | HTTPS | WebSearch の `free` ソースはデフォルトで集約に参加する。`bing`/`brave` は `WEB_SEARCH_ADAPTER` での明示的な指定が必要 |
| 15 | Google Cloud Storage (更新) | `storage.googleapis.com` | HTTPS | バージョン確認 |
| 16 | GitHub Raw (Changelog/Stats) | `raw.githubusercontent.com` | HTTPS | 更新通知 |
| 17 | Chrome UX Report (CrUX) | `chromeuxreport.googleapis.com` | HTTPS | `--chrome` で performance trace を実行するとき |
| 18 | CCR Upstream Proxy | `api.anthropic.com` | WS | CCR リモートセッション |
| 19 | Voice STT | `api.anthropic.com/api/ws/...` | WSS | Voice Mode |
| 20 | Desktop App Download | `claude.ai/api/desktop/...` | HTTPS | ダウンロード案内 |

---

## 詳細

### 1. Anthropic Messages API

会話メッセージを送信してストリーミング応答を受信する、中核の LLM 推論サービスです。

- **エンドポイント**: `https://api.anthropic.com` (production) / `https://api-staging.anthropic.com` (staging)
- **上書き**: 環境変数 `ANTHROPIC_BASE_URL`
- **認証**: API Key / OAuth Token
- **ファイル**: `src/services/api/client.ts`, `src/services/api/claude.ts`

### 2. AWS Bedrock

- **エンドポイント**: `bedrock-runtime.{region}.amazonaws.com`
- **認証**: AWS 認証情報チェーン / `AWS_BEARER_TOKEN_BEDROCK`
- **ファイル**: `src/services/api/client.ts:153-190`, `src/utils/aws.ts`

### 3. Google Vertex AI

- **エンドポイント**: `{region}-aiplatform.googleapis.com`
- **認証**: `GoogleAuth` + `cloud-platform` スコープ
- **ファイル**: `src/services/api/client.ts:221-298`

### 4. Azure Foundry

- **エンドポイント**: `https://{resource}.services.ai.azure.com/anthropic/v1/messages`
- **認証**: API Key または Azure AD `DefaultAzureCredential`
- **ファイル**: `src/services/api/client.ts:191-220`

### 5. OAuth

OAuth 2.0 + PKCE の認可コードフローです。

- **エンドポイント**:
  - `https://platform.claude.com/oauth/authorize` — 認可ページ
  - `https://claude.com/cai/oauth/authorize` — Claude.ai 認可
  - `https://platform.claude.com/v1/oauth/token` — Token の交換
  - `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` — API Key の作成
  - `https://api.anthropic.com/api/oauth/claude_cli/roles` — ロールの取得
  - `https://claude.ai/oauth/claude-code-client-metadata` — MCP クライアントメタデータ
  - `https://claude.fedstart.com` — FedStart 政府向けデプロイ
- **ファイル**: `src/constants/oauth.ts`, `src/services/oauth/`

### 6. GrowthBook (feature flag)

- **エンドポイント**: `https://api.anthropic.com/` (remoteEval モード) または `CLAUDE_GB_ADAPTER_URL`
- **SDK Keys**: `sdk-zAZezfDKGoZuXXKe` (external), `sdk-xRVcrliHIlrg4og4` (ant prod), `sdk-yZQvlplybuXjYh6L` (ant dev)
- **ファイル**: `src/services/analytics/growthbook.ts`, `src/constants/keys.ts`

### 7. Sentry (エラー追跡)

- **有効化**: `SENTRY_DSN` を設定する（デフォルトでは未設定）
- **動作**: エラーだけを報告し、機密性の高い header を自動的に除外する
- **ファイル**: `src/utils/sentry.ts`

### 8. Datadog (ログ)

- **有効化**: `DATADOG_LOGS_ENDPOINT` + `DATADOG_API_KEY` を両方設定する（デフォルトでは未設定）
- **ファイル**: `src/services/analytics/datadog.ts`

### 9. OpenTelemetry Collector

- **有効化**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` または `OTEL_*` 環境変数
- **プロトコル**: gRPC / HTTP / Protobuf。OTLP と Prometheus への export に対応
- **ファイル**: `src/utils/telemetry/instrumentation.ts`

### 10. 1P Event Logging (内部イベント)

- **エンドポイント**: `https://api.anthropic.com/api/event_logging/batch`
- **プロトコル**: バッチ export (間隔 10s、1 バッチ 200 イベント)
- **ファイル**: `src/services/analytics/firstPartyEventLoggingExporter.ts`

### 11. BigQuery Metrics

- **エンドポイント**: `https://api.anthropic.com/api/claude_code/metrics`
- **ファイル**: `src/utils/telemetry/bigqueryExporter.ts`

### 12. MCP Proxy

Anthropic がホストする MCP サーバープロキシです。

- **エンドポイント**: `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}`
- **認証**: Claude.ai OAuth tokens
- **ファイル**: `src/services/mcp/client.ts`, `src/constants/oauth.ts`

### 13. MCP Registry

公式 MCP サーバーの一覧を取得します。

- **エンドポイント**: `https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial`
- **ファイル**: `src/services/mcp/officialRegistry.ts`

### 14. Web Search Pages

WebSearch はデフォルトで複数の検索ソースを集約します。`free` ソース（キー不要、デフォルトで参加）は検索結果ページを直接取得します。
`bing`/`brave` は `WEB_SEARCH_ADAPTER` で明示的に指定した場合にだけ使用します。

- **free ソースのエンジン**（並列 + RRF 統合）:
  - `https://html.duckduckgo.com/html/?q={query}`
  - `https://www.mojeek.com/search?q={query}`
  - `https://www4.bing.com/search?q={query}`（www 版は headless クライアントに challenge を返すが、www4 は返さない）
  - フォールバック: 公開 SearXNG インスタンス（上記 3 つがすべて空または失敗した場合にだけ探索する）
- **Bing エンドポイント**（`WEB_SEARCH_ADAPTER=bing`）: `https://www.bing.com/search?q={query}&setmkt=en-US`
- **Brave エンドポイント**（`WEB_SEARCH_ADAPTER=brave`）: `https://api.search.brave.com/res/v1/llm/context?q={query}`
- **Gemini grounding のリダイレクト解決**: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/...`
  （HEAD リクエストから公開元の実 URL を解決する）
- **ファイル**:
  - `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts`
  - `packages/builtin-tools/src/tools/WebSearchTool/adapters/braveAdapter.ts`

このほか、Domain Blocklist も照会します。
- **エンドポイント**: `https://api.anthropic.com/api/web/domain_info?domain={domain}`
- **ファイル**: `packages/builtin-tools/src/tools/WebFetchTool/utils.ts`

### 15. Google Cloud Storage (自動更新)

- **エンドポイント**: `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases`
- **ファイル**: `src/utils/autoUpdater.ts`

### 16. GitHub Raw Content

- **エンドポイント**: `https://raw.githubusercontent.com/sweetcornna/open-claude-code/refs/heads/main/CHANGELOG.md`（occ 自身の更新情報。`bun run release` が書き込み、リリースコミットとともに main へ push する）
- **エンドポイント**: `https://raw.githubusercontent.com/anthropics/claude-plugins-official/refs/heads/stats/stats/plugin-installs.json`
- **ファイル**: `src/utils/update/releaseNotes.ts`, `src/utils/plugins/installCounts.ts`

### 17. Chrome UX Report (CrUX)

リクエストを送るのは `chrome-devtools-mcp` 子プロセスであり、occ 自体ではありません。

- **エンドポイント**: `https://chromeuxreport.googleapis.com`
- **有効化**: `--chrome` が有効で、**かつ**モデルが `performance_start_trace` / `performance_analyze_insight` を呼び出した場合だけ。trace 内の URL は、実ユーザーのパフォーマンスデータを取得するため Google へ送信される
- **無効化**: server に `--no-performance-crux` を追加する
- **ファイル**: `src/utils/chromeDevtools/setup.ts`（server 引数を構築する）

> `chrome-devtools-mcp` の利用統計送信と更新確認は occ がデフォルトで無効にしています（`--no-usage-statistics` + `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` / `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`）。そのため、この表には含めません。

### 18. CCR Upstream Proxy

- **エンドポイント**: `ws://api.anthropic.com/v1/code/upstreamproxy/ws`
- **有効化**: `CLAUDE_CODE_REMOTE=1` + `CCR_UPSTREAM_PROXY_ENABLED=1`
- **ファイル**: `src/upstreamproxy/upstreamproxy.ts`

### 19. Voice STT

- **エンドポイント**: `wss://api.anthropic.com/api/ws/...`
- **ファイル**: `src/services/voiceStreamSTT.ts`

### 20. Desktop App Download

- **エンドポイント**: `https://claude.ai/api/desktop/win32/x64/exe/latest/redirect` (Windows)
- **エンドポイント**: `https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect` (macOS)
- **ファイル**: `src/components/DesktopHandoff.tsx`

---

## Anthropic API 補助エンドポイント一覧

次のエンドポイントはすべて `api.anthropic.com` 上にあり、機能別に分類しています。

| エンドポイントパス | 用途 | ファイル |
|---|---|---|
| `/api/event_logging/batch` | イベントのバッチ送信 | `src/services/analytics/firstPartyEventLoggingExporter.ts` |
| `/api/claude_code/metrics` | BigQuery metrics の export | `src/utils/telemetry/bigqueryExporter.ts` |
| `/api/oauth/claude_cli/create_api_key` | API Key の作成 | `src/constants/oauth.ts` |
| `/api/oauth/claude_cli/roles` | ユーザーロールの取得 | `src/constants/oauth.ts` |
| `/api/oauth/accounts/grove` | 通知設定 | `src/services/api/grove.ts` |
| `/api/oauth/organizations/{id}/referral/*` | 紹介キャンペーン | `src/services/api/referral.ts` |
| `/api/oauth/organizations/{id}/overage_credit_grant` | 超過クレジット | `src/services/api/overageCreditGrant.ts` |
| `/api/oauth/organizations/{id}/admin_requests` | 管理リクエスト | `src/services/api/adminRequests.ts` |
| `/api/web/domain_info?domain={}` | ドメインの安全性確認 | `src/tools/WebFetchTool/utils.ts` |
| `/api/claude_code/settings` | 設定の同期 | `src/services/settingsSync/index.ts` |
| `/api/claude_code/managed_settings` | 企業管理設定 (1h ごとにポーリング) | `src/services/remoteManagedSettings/index.ts` |
| `/api/auth/trusted_devices` | 信頼済みデバイスの登録 | `src/bridge/trustedDevice.ts` |
| `/mcp-registry/v0/servers` | MCP サーバーレジストリ | `src/services/mcp/officialRegistry.ts` |
| `/v1/files` | ファイルのアップロードとダウンロード | `src/services/api/filesApi.ts` |
| `/v1/sessions/{id}/events` | セッション履歴 | `src/assistant/sessionHistory.ts` |
| `/v1/code/triggers` | リモートトリガー | `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts` |
| `/v1/organizations/{id}/mcp_servers` | 組織の MCP 設定 | `src/services/mcp/claudeai.ts` |

## Anthropic 以外のリモートドメイン一覧

| ドメイン | サービス | プロトコル |
|---|---|---|
| `bedrock-runtime.*.amazonaws.com` | AWS Bedrock | HTTPS |
| `{region}-aiplatform.googleapis.com` | Google Vertex AI | HTTPS |
| `{resource}.services.ai.azure.com` | Azure Foundry | HTTPS |
| `www.bing.com` | Bing 検索 | HTTPS |
| `search.brave.com` | Brave 検索 | HTTPS |
| `storage.googleapis.com` | 自動更新 | HTTPS |
| `raw.githubusercontent.com` | Changelog / プラグイン統計 | HTTPS |
| `bridge.claudeusercontent.com` | Chrome Bridge | WSS |
| `platform.claude.com` | OAuth 認可ページ | HTTPS |
| `claude.com` / `claude.ai` | OAuth / ダウンロード | HTTPS |
| `claude.fedstart.com` | FedStart OAuth | HTTPS |
