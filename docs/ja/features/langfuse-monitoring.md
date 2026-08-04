<!-- lang-switcher -->
[English](/docs/en/features/langfuse-monitoring) · [中文](/docs/zh/features/langfuse-monitoring) · **日本語**

# Langfuse 監視統合

> 実装状況: 完了。環境変数で有効化
> 依存関係: `@langfuse/otel`、`@langfuse/tracing`、`@opentelemetry/sdk-trace-base`

## 1. 機能概要

Langfuse は、AI アプリケーションのリクエスト経路を追跡、監視、デバッグするためのオープンソース LLM 可観測性プラットフォームです。occ は OpenTelemetry (OTel) のブリッジ層を介して Langfuse を query フローへ統合し、次を実現します。

- **LLM 呼び出しの追跡** — 各 API リクエストのモデル、Provider、入力/出力、Token 使用量を記録する
- **ツール実行の追跡** — 各ツール呼び出しの名前、入力、出力、所要時間、エラーを記録する
- **複数 Agent の追跡** — メイン Agent とサブ Agent にそれぞれ独立した Trace 経路を持たせる
- **データのサニタイズ** — 機密情報（API Key、ファイル内容、Shell 出力など）を自動的にマスクする

## 2. 有効化方法

Langfuse はオープンソースプロジェクトです。Docker / Kubernetes で**セルフホスト**することも、公式の **[Langfuse Cloud](https://cloud.langfuse.com)** で無料テストすることもできます。登録後、Project Settings → API Keys ページでキーを取得してください。

必要な環境変数は基本的に 3 つだけです。

| 環境変数 | 説明 |
|---------|------|
| `LANGFUSE_PUBLIC_KEY` | Langfuse の公開鍵（必須） |
| `LANGFUSE_SECRET_KEY` | Langfuse の秘密鍵（必須） |
| `LANGFUSE_BASE_URL` | サービス URL。デフォルトは `https://cloud.langfuse.com`。セルフホスト時は自分の URL に変更する（必須） |

未設定の場合、すべての追跡関数が no-op になり、オーバーヘッドはありません。

### settings.json で設定（推奨）

`.occ/settings.json` の `env` フィールドへ追加すると、起動するたびに自動で有効になります。

```json
{
  "env": {
    "LANGFUSE_PUBLIC_KEY": "pk-xxx",
    "LANGFUSE_SECRET_KEY": "sk-xxx",
    "LANGFUSE_BASE_URL": "https://cloud.langfuse.com"
  }
}
```

### その他のオプション

| 環境変数 | デフォルト値 | 説明 |
|---------|--------|------|
| `LANGFUSE_TRACING_ENVIRONMENT` | `development` | Langfuse パネルでのフィルタに使う環境ラベル |
| `LANGFUSE_FLUSH_AT` | `20` | 一括送信する span 数のしきい値 |
| `LANGFUSE_FLUSH_INTERVAL` | `10` | 定期 flush の間隔（秒） |
| `LANGFUSE_EXPORT_MODE` | `batched` | export モード: `batched`（一括）または `immediate`（即時） |
| `LANGFUSE_TIMEOUT` | `5` | リクエストタイムアウト（秒） |

## 4. アーキテクチャ

### 4.1 モジュール構成

```
src/services/langfuse/
├── index.ts          # 統一 export
├── client.ts         # OTel Provider + LangfuseSpanProcessor の初期化
├── tracing.ts        # Trace/Span の作成、LLM とツールの observation 記録
├── convert.ts        # 内部 Message 型 → Langfuse の OpenAI 互換形式へ変換
└── sanitize.ts       # データのサニタイズ（機密フィールド、ファイルパス、ツール出力）
```

### 4.2 追跡階層

```
Trace (Agent Span)                    ← createTrace() / createSubagentTrace()
  ├── Generation (LLM 呼び出し)       ← recordLLMObservation()
  ├── Tool Observation (ツール呼び出し) ← recordToolObservation()
  ├── Tool Observation (ツール呼び出し) ← recordToolObservation()
  └── ...
```

### 4.3 データフロー

```
query.ts  ──→  createTrace()           # query turn ごとに root trace を作成
  │
  ├── claude.ts  ──→  recordLLMObservation()   # API 呼び出しの完了後に LLM observation を記録
  │
  ├── toolExecution.ts  ──→  recordToolObservation()  # ツール実行ごとに記録
  │
  └── query.ts  ──→  endTrace()         # turn 終了時に trace を閉じる

runAgent.ts  ──→  createSubagentTrace()  # サブ Agent は独立した trace を持つ
```

## 5. 追跡の詳細

### 5.1 メイン Agent Trace

`query()` 呼び出しごと（ユーザーとの 1 回の会話 turn）に、型が `agent` の root Span を作成します。

- **名前**: `agent-run` または `agent-run:<querySource>`
- **メタデータ**: `provider`、`model`、`agentType: "main"`
- **Session ID**: Langfuse の Session 機能へ関連付け、セッション単位の集約をサポートする

### 5.2 サブ Agent Trace

`AgentTool` から起動したサブ Agent は独立した Trace を作成します。

- **名前**: `agent:<agentType>`
- **メタデータ**: `provider`、`model`、`agentType`、`agentId`
- メイン Trace とは独立し、固有の Session 関連付けを持つ

### 5.3 LLM Generation

各 API 呼び出しを `generation` 型の Span として記録します。

- **名前**: Provider に応じてマッピングする（`ChatAnthropic`、`ChatOpenAI`、`ChatBedrockAnthropic` など）
- **記録内容**: 入力メッセージ、出力メッセージ、Token 使用量（input/output）
- **時間**: `startTime`、`endTime`、`completionStartTime`（TTFT 指標）を正確に記録する

Provider 名のマッピング:

| Provider | Generation 名 |
|----------|-----------------|
| `firstParty` | `ChatAnthropic` |
| `bedrock` | `ChatBedrockAnthropic` |
| `vertex` | `ChatVertexAnthropic` |
| `foundry` | `ChatFoundry` |
| `openai` | `ChatOpenAI` |
| `gemini` | `ChatGoogleGenerativeAI` |
| `grok` | `ChatXAI` |

### 5.4 ツール実行

各ツール呼び出しを `tool` 型の Span として記録します。

- **名前**: ツール名（`FileEditTool`、`BashTool` など）
- **記録内容**: 入力（サニタイズ済み）、出力（サニタイズ済み）、`toolUseId`
- **エラーの印**: `isError` flag + `level: ERROR`

## 6. データのサニタイズ

Langfuse へアップロードするすべてのデータは、機密情報の漏えいを防ぐためにサニタイズされます（`sanitize.ts`）。

### 6.1 グローバルサニタイズ（`sanitizeGlobal`）

- **Home パスの置換** — `/Users/xxx` → `~`
- **機密フィールドのマスク** — `api_key`、`token`、`secret`、`password`、`credential`、`auth_header` などのキーワードと一致するフィールド値を `[REDACTED]` に置換する

### 6.2 ツール入力のサニタイズ（`sanitizeToolInput`）

- 機密フィールドをマスクする（グローバルと同じ）
- `file_path`、`path`、`directory` パス内の Home ディレクトリを置換する

### 6.3 ツール出力のサニタイズ（`sanitizeToolOutput`）

| ツール | サニタイズ方針 |
|------|---------|
| `FileReadTool`、`FileWriteTool`、`FileEditTool` | 完全にマスクし、文字数だけを残す: `[file content redacted, N chars]` |
| `BashTool`、`PowerShellTool` | 500 文字までに切り詰める |
| `ConfigTool`、`MCPTool` | 完全にマスクする |
| その他のツール | そのまま残す |

## 7. メッセージ形式の変換

`convert.ts` は occ 内部の Message 型を Langfuse が期待する OpenAI 互換形式へ変換します。

- **入力**: `UserMessage | AssistantMessage[]` + 任意の system prompt → `{ role, content }[]`
- **出力**: `AssistantMessage[]` → `{ role: 'assistant', content }`
- **Content Block のマッピング**:
  - `text` → `{ type: 'text', text }`
  - `thinking` / `redacted_thinking` → `{ type: 'thinking', thinking }`
  - `tool_use` → `{ type: 'tool_use', id, name, input }`
  - `tool_result` → `{ type: 'tool_result', tool_use_id, content }`
  - `image` / `document` → プレースホルダー `[image]` / `[document: name]`

## 8. ライフサイクル

1. **初期化** — `initLangfuse()` は `src/entrypoints/init.ts` の起動時に呼び出され、`LangfuseSpanProcessor` と `BasicTracerProvider` を作成する
2. **実行時** — 各追跡関数は `isLangfuseEnabled()` で確認し、未設定なら直ちに `null` を返すか処理をスキップする
3. **終了** — `shutdownLangfuse()` はプロセス終了時に呼び出され、強制 flush して Processor を閉じる

## 9. Langfuse のセルフホスト

Langfuse はオープンソースプロジェクトであり、Docker / Kubernetes によるセルフホストをサポートします。

```bash
docker run -d \
  --name langfuse \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://... \
  langfuse/langfuse:latest
```

セルフホスト後、`LANGFUSE_BASE_URL` をインスタンスの URL に設定します。詳細は [Langfuse セルフホストドキュメント](https://langfuse.com/docs/deployment/self-host) を参照してください。

セルフホストが不要なら、テストに利用できる無料枠を提供する [Langfuse Cloud](https://cloud.langfuse.com) をそのまま利用できます。

## 10. 関連ファイル

| ファイル | 説明 |
|------|------|
| `src/services/langfuse/client.ts` | OTel Provider の初期化、ライフサイクル管理 |
| `src/services/langfuse/tracing.ts` | Trace/Span の作成と observation の記録 |
| `src/services/langfuse/convert.ts` | Message 形式の変換 |
| `src/services/langfuse/sanitize.ts` | データのサニタイズ |
| `src/services/langfuse/__tests__/langfuse.test.ts` | テスト（568 行） |
| `src/query.ts` | メイン query フローへの Trace 統合 |
| `src/services/tools/toolExecution.ts` | ツール実行での observation の記録 |
| `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` | サブ Agent Trace の作成 |
