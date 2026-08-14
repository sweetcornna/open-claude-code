<!-- lang-switcher -->
[English](/docs/en/telemetry-remote-config-audit) · [中文](/docs/zh/telemetry-remote-config-audit) · **日本語**

# テレメトリとリモート設定配信システムの監査（Sentry を除く）

> **2.45.0 以降: `api.anthropic.com` 宛のファーストパーティ経路はデフォルトで無効であり、明示的な opt-in が必要です。**
> `OCC_ENABLE_1P_TELEMETRY=1` で第 2 節のイベント送信を、`OCC_ENABLE_GROWTHBOOK=1` で第 3 節のリモート
> feature flag 取得を有効化します。2 つのスイッチは互いに独立しており、環境変数からのみ読み取られます
> （`settings.json` の `env` ブロックが永続化の形式です）。
> 上流はこの 2 経路を「ユーザーが opt-out していないこと」に紐づけています。フォークにとってそれは、
> サードパーティのセッションデータを Anthropic へ送り、リモートの実験 payload がローカルの挙動を長期間
> 操作することを意味するため、occ はデフォルトを反転させました。

## 1. Datadog ログ

**ファイル**: `src/services/analytics/datadog.ts`

- **エンドポイント**: 環境変数 `DATADOG_LOGS_ENDPOINT` で設定する（デフォルトは空、つまり無効）
- **クライアントトークン**: 環境変数 `DATADOG_API_KEY` で設定する（デフォルトは空、つまり無効）
- **動作**: ログをバッチ送信する（flush 間隔 15s、上限 100 件）。対象は 1P（Anthropic API への直接接続）ユーザーだけ
- **イベント許可リスト**: `tengu_*` 系のイベント（起動、エラー、OAuth、ツール呼び出しなど約 35 種類）
- **ベースラインデータ**: model、platform、arch、version、userBucket（ユーザーをハッシュ化して 30 個のバケットに分割）などを収集する
- **限定条件**: `NODE_ENV === 'production'`
- **設定例**: `DATADOG_LOGS_ENDPOINT=https://http-intake.logs.datadoghq.com/api/v2/logs DATADOG_API_KEY=xxx bun run dev`

## 2. 1P イベントログ（BigQuery）

**ファイル**: `src/services/analytics/firstPartyEventLogger.ts` + `firstPartyEventLoggingExporter.ts`

- **エンドポイント**: `https://api.anthropic.com/api/event_logging/batch`（staging に切り替え可能）
- **スイッチ**: **デフォルト無効**。`OCC_ENABLE_1P_TELEMETRY=1` が必要（`is1PEventLoggingEnabled()`）
- **動作**: OpenTelemetry SDK の `BatchLogRecordProcessor` を使用し、Anthropic が所有する BQ パイプラインへバッチ export する
- **認証情報**: `getAuthHeaders()` ではなく `getFirstPartyTelemetryAuthHeaders()` を経由する。DeepSeek / OpenCode の wire はサードパーティの鍵を `ANTHROPIC_API_KEY` にミラーするため、その値は `x-api-key` として送信されない（代わりに認証なしで POST する）
- **データ**: 完全なイベント metadata（session、model、env context、ユーザーデータ、subscription type など）
- **耐障害性**: 失敗したイベントをローカルディスクへ永続化する（JSONL）。二乗バックオフで再試行し、最大 8 回試行する
- **Proto schema**: イベントを `ClaudeCodeInternalEvent` / `GrowthbookExperimentEvent` protobuf 形式にシリアライズする
- **Auth fallback**: 401 の場合は auth header を自動的に外して再試行する

## 3. GrowthBook リモート Feature Flags / 動的設定

**ファイル**: `src/services/analytics/growthbook.ts`

- **サーバー**: `https://api.anthropic.com/`（remote eval モード）
- **スイッチ**: **デフォルト無効**。`OCC_ENABLE_GROWTHBOOK=1` が必要。自前ホストのアダプター（`CLAUDE_GB_ADAPTER_URL` + `CLAUDE_GB_ADAPTER_KEY`）は影響を受けない
- **動作**: 起動時にすべての feature flags を取得し、6h（外部ユーザー）/ 20min（ant）ごとに更新する
- **ディスクキャッシュ**: **廃止**。リモート payload はメモリ上にのみ存在し、プロセス終了で消える。既存の `~/.occ.json` の `cachedGrowthBookFeatures` は `/logout` と起動時の `purgeCachedRemoteGates()` が削除する
- **ローカルのフォールバック**: `LOCAL_GATE_DEFAULTS`（`growthbook.ts`）は配信値より優先される。opt-in したユーザーと自前アダプターにとって最後の砦
- **用途**:
  - Datadog の有効・無効を制御する（`tengu_log_datadog_events`）
  - イベントの sampling rate を制御する（`tengu_event_sampling_config`）
  - sink killswitch を制御する（`tengu_frond_boric`）
  - BQ batch 設定を制御する（`tengu_1p_event_batch_config`）
  - バージョン上限と自動更新 kill switch を制御する
  - リモート管理設定のセキュリティチェック gate を制御する
- **ユーザー属性**: deviceId, sessionId, organizationUUID, accountUUID, email, subscriptionType などを送信する

## 4. Remote Managed Settings（企業向けリモート設定配信）

**ファイル**: `src/services/remoteManagedSettings/index.ts`

- **エンドポイント**: `{BASE_API_URL}/api/claude_code/settings`
- **動作**: 企業ユーザー向けに設定を配信する。ETag/304 キャッシュに対応し、バックグラウンドで 1 時間ごとにポーリングする
- **安全性**: 変更に「危険な設定」が含まれる場合はダイアログを表示してユーザーに確認する
- **対象**: API key ユーザーは全員取得できる。OAuth ユーザーは Enterprise/C4E/Team だけ
- **Fail-open**: リクエストに失敗した場合はローカルキャッシュを使用し、キャッシュがなければスキップする

## 5. Settings Sync（設定同期）

**ファイル**: `src/services/settingsSync/index.ts`

- **エンドポイント**: `{BASE_API_URL}/api/claude_code/user_settings`
- **動作**: CLI はローカルの設定/memory をリモートへアップロードし、CCR モードではリモートからダウンロードする
- **同期内容**: userSettings、userMemory、projectSettings、projectMemory
- **Feature gate**: `UPLOAD_USER_SETTINGS` / `DOWNLOAD_USER_SETTINGS`
- **ファイルサイズ上限**: 500KB/ファイル

## 6. OpenTelemetry サードパーティーテレメトリ

**ファイル**: `src/utils/telemetry/instrumentation.ts`

- **動作**: OTEL SDK を完全に初期化し、metrics / logs / traces の 3 種類の signal に対応する
- **プロトコル**: gRPC / http-json / http-protobuf（`OTEL_EXPORTER_OTLP_PROTOCOL` で選択）
- **exporter**: console / otlp / prometheus
- **トリガー**: 環境変数 `CLAUDE_CODE_ENABLE_TELEMETRY=1`
- **拡張 trace**: `feature('ENHANCED_TELEMETRY_BETA')` + GrowthBook gate `enhanced_telemetry_beta`

## 7. BigQuery Metrics Exporter（内部 metrics）

**ファイル**: `src/utils/telemetry/bigqueryExporter.ts`

- **エンドポイント**: `https://api.anthropic.com/api/claude_code/metrics`
- **動作**: OTel metrics を内部 BQ へ定期的に export する（間隔 5min）
- **対象**: API 顧客、C4E/Team サブスクライバー。さらに `CLAUDE_CODE_ENABLE_TELEMETRY=1` が必要
- **認証情報**: 第 2 節と同じく `getFirstPartyTelemetryAuthHeaders()` を経由する
- **組織単位の opt-out**: `checkMetricsEnabled()` API で照会する（下記の項目 8 を参照）

## 8. 組織単位の Metrics Opt-out 照会

**ファイル**: `src/services/api/metricsOptOut.ts`

- **エンドポイント**: `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`
- **動作**: 組織で metrics が有効かどうかを照会する。2 段階キャッシュ（メモリ 1h + ディスク 24h）を使用する
- **役割**: BigQuery metrics exporter が export するかどうかを制御する

## 9. Startup Profiling

**ファイル**: `src/utils/startupProfiler.ts`

- **動作**: 起動パフォーマンスデータを sampling し（ant 100% / 外部 0.5%）、`logEvent('tengu_startup_perf')` で報告する
- **詳細モード**: `CLAUDE_CODE_PROFILE_STARTUP=1` を設定すると、完全なパフォーマンスレポートをファイルに出力する

## 10. Beta Session Tracing

**ファイル**: `src/utils/telemetry/betaSessionTracing.ts`

- **動作**: system prompt、model output、tool schema などを送信する詳細なデバッグ trace
- **トリガー**: `ENABLE_BETA_TRACING_DETAILED=1` + `BETA_TRACING_ENDPOINT`
- **外部ユーザー**: SDK/headless モードでは自動的に有効になる。対話モードでは GrowthBook gate `tengu_trace_lantern` が必要

## 11. Bridge Poll Config（リモートポーリング間隔の設定）

**ファイル**: `src/bridge/pollConfig.ts`

- **動作**: GrowthBook から bridge のポーリング間隔設定（`tengu_bridge_poll_interval_config`）を取得する
- **制御対象**: 単一セッションと複数セッションの各種 poll interval

## 12. Plugin/MCP テレメトリ

**ファイル**: `src/utils/plugins/fetchTelemetry.ts`

- **動作**: plugin/marketplace のネットワークリクエスト（インストール数、marketplace の clone/pull など）を記録する
- **イベント**: `tengu_plugin_remote_fetch`。host（マスキング済み）、outcome、duration を含む

---

## スイッチ一覧

```bash
# ファーストパーティ経路はデフォルト無効。有効化する手段はこの 2 つだけで、互いに独立している
OCC_ENABLE_1P_TELEMETRY=1   # 第 2 節: api.anthropic.com へのイベント送信
OCC_ENABLE_GROWTHBOOK=1     # 第 3 節: リモート feature flag の取得
```

opt-out は opt-in より優先されます。以下のいずれかを設定すると、上記 2 つのスイッチは効きません。

```bash
# すべてのテレメトリを無効化（Datadog + 1P + アンケート）
DISABLE_TELEMETRY=1

# より強力: 必須ではないすべてのネットワーク通信を無効化（自動更新、grove、release notes などを含む）
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# 3P provider では自動的に無効化
CLAUDE_CODE_USE_BEDROCK=1  # または VERTEX/FOUNDRY
```

`src/utils/privacyLevel.ts` が一元的な制御点であり、3 つのレベル `default < no-telemetry < essential-traffic` を定義します。

---

## データフローアーキテクチャ

```
ユーザー操作 → logEvent()
                 ↓
            sink.ts (ルーティング層)
              ↙        ↘
   trackDatadogEvent()   logEventTo1P()
          ↓                      ↓
   Datadog HTTP API     OTel BatchLogRecordProcessor
   (us5.datadoghq.com)       ↓
                    FirstPartyEventLoggingExporter
                             ↓
                    api.anthropic.com/api/event_logging/batch
                             ↓
                    BigQuery (ClaudeCodeInternalEvent proto)
```

GrowthBook は独立したチャネルとして、上記 2 つの sink の有効・無効と設定を同時に制御します。デフォルト状態ではどちらの経路も起動しません。`logEventTo1P()` は `is1PEventLoggingEnabled()` のチェックで戻り、GrowthBook client はそもそも生成されません。
