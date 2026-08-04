<!-- lang-switcher -->
[English](/docs/en/features/web-search-tool) · [中文](/docs/zh/features/web-search-tool) · **日本語**

# WEB_SEARCH_TOOL — Web 検索ツール

> 実装状況: アダプターアーキテクチャは完成。API / Bing / Brave の 3 バックエンドをサポート
> 参照数: コアツール。feature flag のゲートなし（常に有効）

## 1. 機能概要

WebSearchTool を使うと、モデルはインターネットを検索して最新情報を取得できます。元の実装は Anthropic API のサーバー側検索（`web_search_20250305` server tool）だけをサポートし、サードパーティのプロキシエンドポイントでは利用できませんでした。現在はアダプターアーキテクチャへリファクタリングされ、API のサーバー側検索に加えて、HTML を解析する Bing / Brave の 2 バックエンドをサポートしています。これにより、どの API エンドポイントでも検索機能を利用できます。

## 2. 実装アーキテクチャ

### 2.1 アダプターパターン

```
WebSearchTool.call()
       │
       ▼
  createAdapter()  ← アダプターファクトリ
       │
       ├── ApiSearchAdapter  — Anthropic 公式 API のサーバー側検索
       │     └── web_search_20250305 server tool を使用
       │         queryModelWithStreaming から API を再度呼び出す
       │
       ├── BingSearchAdapter  — Bing HTML の取得 + 正規表現による抽出
       │     └── Bing 検索ページの HTML を直接取得
       │         b_algo ブロックからタイトル/URL/概要を正規表現で抽出
       │
       └── BraveSearchAdapter — Brave LLM Context API
             └── Brave の HTTPS GET インターフェースを呼び出す
                 grounding payload をタイトル/URL/概要へマッピング
```

### 2.2 モジュール構成

| モジュール | ファイル | 説明 |
|------|------|------|
| ツールのエントリ | `packages/builtin-tools/src/tools/WebSearchTool/WebSearchTool.ts` | `buildTool()` の定義: schema、権限、実行、出力の整形 |
| ツール prompt | `packages/builtin-tools/src/tools/WebSearchTool/prompt.ts` | 検索ツールの system prompt |
| UI 描画 | `packages/builtin-tools/src/tools/WebSearchTool/UI.tsx` | 検索結果をターミナルに描画するコンポーネント |
| アダプターインターフェース | `packages/builtin-tools/src/tools/WebSearchTool/adapters/types.ts` | `WebSearchAdapter` インターフェース、`SearchResult`/`SearchOptions`/`SearchProgress` 型 |
| アダプターファクトリ | `packages/builtin-tools/src/tools/WebSearchTool/adapters/index.ts` | バックエンドを選ぶ `createAdapter()` ファクトリ関数 |
| API アダプター | `packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts` | 従来の `queryModelWithStreaming` ロジックをラップし、server tool を使う |
| Bing アダプター | `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts` | Bing HTML の取得 + 正規表現による解析 |
| Brave アダプター | `packages/builtin-tools/src/tools/WebSearchTool/adapters/braveAdapter.ts` | Brave LLM Context API の適応と結果のマッピング |
| 単体テスト | `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.test.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/braveAdapter*.test.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/adapterFactory.test.ts` | Bing / Brave の解析とファクトリロジックのテスト |
| 統合テスト | `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.integration.ts`, `packages/builtin-tools/src/tools/WebSearchTool/__tests__/braveAdapter.integration.ts` | 実際のネットワークリクエストによる検証 |

### 2.3 データフロー

```
モデルが WebSearchTool(query, allowed_domains, blocked_domains) を呼び出す
       │
       ▼
  validateInput() — query が空でないこと、allowed/block が共存しないことを検証
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
       │     └── API 認証ヘッダー
       │
       ├── extractResults(payload) — バックエンドごとに結果を抽出
       │     └── grounding → SearchResult[] のマッピング
       │
       ├── クライアント側のドメインフィルタ（allowedDomains / blockedDomains）
       │
       ├── onProgress({ type: 'search_results_received', resultCount })
       │
       ▼
  markdown のリンク一覧に整形してモデルへ返す
```

## 3. Bing アダプターの技術詳細

### 3.1 スクレイピング対策の回避

13 個の Edge ブラウザリクエストヘッダー（`Sec-Ch-Ua`、`Sec-Fetch-*` など）を使い、Bing が JS 描画用の空ページを返すのを避けます。

```typescript
const BROWSER_HEADERS = {
  'User-Agent': '...Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Sec-Ch-Ua': '"Microsoft Edge";v="131", "Chromium";v="131", ...',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  // ... 合計 13 ヘッダー
}
```

`setmkt=en-US` パラメータで米国英語の市場を強制し、IP の geolocation による結果の地域化を避けます。

### 3.2 URL デコード（`resolveBingUrl()`）

Bing が返すリダイレクト URL の形式: `bing.com/ck/a?...&u=a1aHR0cHM6Ly9...`

- `u` パラメータの先頭 2 文字はプロトコル接頭辞: `a1` = https、`a0` = http
- 残りは実際の URL を base64url でエンコードしたもの
- Bing の内部リンクと相対パスはフィルタされ、`undefined` を返す

### 3.3 概要の抽出（`extractSnippet()`）

3 段階のフォールバック戦略:

1. `<p class="b_lineclamp...">` — Bing の検索概要段落
2. `<div class="b_caption">` 内の `<p>` — 代替の概要位置
3. `<div class="b_caption">` の直接テキスト — 最終 fallback

### 3.4 ドメインフィルタ

クライアント側で実装し、サブドメインの照合もサポートします。
- `allowedDomains`: allowlist。結果のドメインがリスト内のいずれか（サブドメインを含む）と一致する必要がある
- `blockedDomains`: blocklist。一致する結果を除外する
- 両方を同時には使えない（`validateInput` で検証）

## 4. 検索ソースと集約

デフォルト動作は「バックエンドを 1 つ選ぶ」のではなく、**接続済みのすべての検索ソースを並列実行し、結果を 1 つにまとめる**ことです。

### 4.1 対称な 4 ソース（`adapters/searchSources.ts`）

| ソース | 実行 | 認証情報 |
|---|---|---|
| `anthropic` | Anthropic server-side `web_search_20250305` | Claude OAuth または `ANTHROPIC_API_KEY` |
| `gemini` | Gemini `generateContent` + `googleSearch` grounding | Google(Antigravity) OAuth または `GEMINI_API_KEY` |
| `codex` | OpenAI Responses API 組み込みの `web_search` ツール | ChatGPT OAuth または `OPENAI_API_KEY` |
| `free` | キー不要の複数エンジンスクレイピング（sweetcornna/free-search-mcp から移植） | なし |

**認証情報があればデフォルトで有効**です。settings にはユーザーの明示的な変更（`webSearchSources.<id>`）だけを保存し、未変更のソースは認証情報の有無に従います。
パネルは `/search-setting` にあります（選択、ログイン、切断）。

### 4.2 集約規則（`adapters/aggregateAdapter.ts`）

- 現在のメインループ provider に対応するソースが**主経路**になり、その結果を先頭に置く。それ以外の有効なソースは**拡張経路**として、主経路にない URL だけを補う。同じ認証情報からは 1 経路だけを送信する（メインループが Gemini なら gemini の拡張経路は送信しない）
- すべてを並列で開始する。主経路が戻った後、拡張経路には短い猶予（`ENHANCER_GRACE_MS`、2s）だけを与え、タイムアウトした結果は破棄する。遅いスクレイピングでユーザーが余計に待つ時間は最大 2 秒であり、検索全体を停滞させない
- 主経路が失敗または空なら、拡張経路を**最後まで待つ**（拡張対象がない場合は、それらが回答になる）
- 単一経路の失敗は黙って無視し、**すべての経路が失敗**した場合だけツールへエラーを投げる
- 正規化した URL（fragment、utm/gclid などの追跡パラメータ、末尾のスラッシュを除去）で重複を排除し、総数は `num_results`（デフォルト 8）を上限とする
- Gemini の grounding URL は `vertexaisearch.cloud.google.com/grounding-api-redirect/…` というリダイレクトラッパーなので、まず HEAD のリダイレクト追跡で実際の URL を解決してから、重複排除とドメインフィルタを行う

**主経路 / 拡張経路は並び順だけではなく、リクエストの送信方法も決定します**。3 つのソースはそれぞれ異なる方式を使います。

| ソース | 主経路 | 拡張経路 |
| --- | --- | --- |
| `anthropic` | セッション自身の query パイプライン（`ApiSearchAdapter`）を通す | 独立した Messages 呼び出し（`AnthropicDirectSearchAdapter`）。パイプラインはリクエストを現在の provider へルーティングするため、拡張経路では使えない |
| `gemini` | `GEMINI_AUTH_MODE` に基づいて公開エンドポイントか Antigravity を選ぶ | Google ログインがあれば Antigravity を使う |
| `codex` | `OPENAI_AUTH_MODE` に基づいて API key か ChatGPT OAuth を選ぶ | 接続済みの ChatGPT アカウントを優先し、未ログインの場合だけ API key へフォールバックする |

**Gemini のモデルはルートに合わせる必要があります**。Antigravity バックエンドは固有の model id（`gemini-3.1-pro-low` /
`gemini-3.1-flash-lite` / `gemini-pro-agent`）だけを提供し、公開 id はすべて 404 `Requested entity was not found` を返します。
そのため検索 lane はルートに応じてデフォルトモデルを選び（Antigravity は flash-lite、公開エンドポイントは `gemini-2.5-flash`）、
公開用の `GEMINI_MODEL` をそのまま Antigravity へ転送することも**ありません**。

### 4.3 明示指定（集約をスキップ）

`WEB_SEARCH_ADAPTER` 環境変数 > `settings.webSearchAdapter` の順で優先し、値は
`api|codex|gemini|free|bing|brave|exa` です。一致した場合は**そのソースだけ**を実行します。
認識できない値（削除済みの `tavily` など）は、何も表示せずにデフォルトの集約へフォールバックします。

ソースの明示指定は、そのソースをセッションの provider にするものではありません。`api`/`gemini`/`codex` は引き続き 4.2 の表に従って主経路か拡張経路かを決定します。

`brave` には `BRAVE_SEARCH_API_KEY` または `BRAVE_API_KEY` が必要です。`exa` には `exaApiKey` を設定できます。

## 5. インターフェース定義

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

### ツールの Input Schema

```typescript
{
  query: string              // 検索キーワード。2 文字以上
  allowed_domains?: string[] // ドメイン allowlist
  blocked_domains?: string[] // ドメイン blocklist
}
```

## 6. ファイル索引

| ファイル | 責務 |
|------|------|
| `packages/builtin-tools/src/tools/WebSearchTool/WebSearchTool.ts` | ツール定義のエントリ |
| `packages/builtin-tools/src/tools/WebSearchTool/prompt.ts` | 検索ツールの prompt |
| `packages/builtin-tools/src/tools/WebSearchTool/UI.tsx` | ターミナル UI の描画 |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/types.ts` | アダプターインターフェース |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/index.ts` | アダプターファクトリ |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts` | API サーバー側検索アダプター |
| `packages/builtin-tools/src/tools/WebSearchTool/adapters/bingAdapter.ts` | Bing HTML 解析アダプター |
| `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.test.ts` | 単体テスト (32 cases) |
| `packages/builtin-tools/src/tools/WebSearchTool/__tests__/bingAdapter.integration.ts` | 統合テスト |
| `src/tools.ts` | ツール登録 |
