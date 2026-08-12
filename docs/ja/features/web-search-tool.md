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
- **追跡リンクが相対パス（`/ck/a?...&u=a1...`）で書かれていても発行元 URL を復元できます**。実際の URL は
  base64 の中にあり、href が絶対か相対かとは無関係です。まずデコードし、デコードできなかったものにだけ
  形状のルールを適用します。そうしないと、相対形式を出力する SERP は 1 ページ丸ごと捨てられます
  （上流 free-search-mcp v0.9.2 に追従）
- デコード可能な対象を持たない Bing の内部リンクと相対 / アンカーリンクは、引き続きフィルタされ `undefined` を返す

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

### 4.1 対称な 7 ソース（`adapters/searchSources.ts`）

表の順序がパネルの順序であり、拡張経路のマージ優先度でもあります。

| ソース | 実行 | 認証情報 |
|---|---|---|
| `anthropic` | Anthropic server-side `web_search_20250305` | **固定した認証情報** > Claude OAuth または `ANTHROPIC_API_KEY` |
| `deepseek` | DeepSeek server-side `web_search_20250305`（`<base>/anthropic` 経由） | **固定した認証情報** > DeepSeek エンドポイントと key（`OPENAI_BASE_URL` が api.deepseek.com を指す） |
| `gemini` | Gemini `generateContent` + `googleSearch` grounding | **固定した認証情報** > Google(Antigravity) OAuth > **ログインの複製**（4.1.3） > `GEMINI_API_KEY` |
| `codex` | OpenAI Responses API 組み込みの `web_search` ツール | **固定した認証情報** > ChatGPT OAuth > **ログインの複製**（4.1.3） > `OPENAI_API_KEY`（key の 2 経路はいずれもエンドポイントが api.openai.com であることが必要） |
| `brave` | Brave LLM Context API（独立インデックス） | `settings.braveApiKey`、または `BRAVE_SEARCH_API_KEY` / `BRAVE_API_KEY` |
| `exa` | Exa のニューラル検索（MCP エンドポイント） | `settings.exaApiKey` |
| `free` | キー不要の複数エンジンスクレイピング（sweetcornna/free-search-mcp から移植） | なし |

**認証情報があればデフォルトで有効**です。settings にはユーザーの明示的な変更（`webSearchSources.<id>`）だけを保存し、未変更のソースは認証情報の有無に従います。
パネルは `/search-setting` にあります（選択、ログイン、切断）。

**`brave` / `exa` は、設定された key がそのまま認証情報**であり、意味付けはログインと完全に同じです。key が
なければ点灯せず、明示的な「off」が常に優先され、key のないソースにチェックを入れても能力は生まれません。
明示指定専用ではなくレジストリに入っている理由は、それまで「ユーザーが自分で課金したインデックス」を使う
唯一の方法が `WEB_SEARCH_ADAPTER=brave` であり、それは**他のすべてのソースを止めてしまう**からです。
判定は各アダプタに「実際にどの key を送るか」を問い合わせます（`resolveBraveApiKey` / `resolveExaApiKey`）。
そのため「パネルが接続済みと表示する」ことと「リクエストが key を持つ」ことがずれることはありません。

**`bing` は意図的にレジストリへ入れていません**。`free` 経路の内部 Bing エンジンと同じエンドポイント・同じ
送信元 IP を叩くため、集約に加えると 1 つのクォータを二重に消費し、両方が CAPTCHA を引く確率も倍になります。
明示指定でなら引き続き利用できます（4.3 を参照）。

### 4.1.1 認証情報の固定（`services/search/searchCredentialStore.ts`）

**問題**：検索の認証情報は、これまで**メイン provider の設定に完全に寄生**していました。4 つの provider
ソースはいずれも `GEMINI_API_KEY` / `OPENAI_API_KEY` + `OPENAI_BASE_URL` / `ANTHROPIC_API_KEY` を環境変数から
直接読んでいます。ところがそれらは `/logout` が削除するキー（`ALL_PROFILE_ENV_KEYS` から導出される
`LOGOUT_ENV_KEYS`）そのものであり、`activateProfile()` が対象プロファイルを適用する前に**全家族分をまとめて
消去する**キーでもあります。そのため「ログアウトした」あるいは単に「OpenAI プロファイルから OpenCode
プロファイルへ切り替えた」だけで、Web 検索は何の通知もないままキー不要のスクレイピング経路へ静かに退行して
いました。

**対処**：`/search-setting` で `S` を押すと、そのソースが**今まさに使っている** key とエンドポイントを occ
自身の認証情報ファイルへ書き込みます。

| 項目 | 値 |
| --- | --- |
| パス | `occConfigPath('search-credentials.json')`（= `~/.occ/search-credentials.json`、`OCC_CONFIG_DIR` に追従） |
| 権限 | `0600`、`writePrivateFileAtomic` によるアトミック書き込み |
| 形状 | `{ version, sources: { <ソース>: { apiKey, baseURL?, pinnedAt } } }` —— **ソースごとに独立**、単一の blob ではない |
| 固定可能なソース | `anthropic`、`deepseek`、`gemini`、`codex` |

**解決順序：固定した認証情報 → provider 環境変数。** 固定していないユーザーの挙動は改修前とバイト単位で同一
であり、検索を続けるための移行手順は一切不要です。

自明でない規則：

- **`settings.json` には書かない**。あのファイルはユーザーが issue に丸ごと貼るものであり、0600 でもありません。
- **`/logout` も `activateProfile()` もこのファイルに触れません** —— 「特定のキーを除外するのを忘れない」から
  ではなく、そもそも両者が書き換える範囲の外にあるからです。回帰テストが各 1 本ずつ固定しています。
- **`/logout` はそれを明示します**。ログアウト後にまだ固定された認証情報があれば、メッセージが該当ソース名を
  列挙し、`/search-setting` の `D` で削除できることを伝えます。黙って削除せず残すのは、固定がソースごとの
  明示的なユーザー操作であり、黙って取り消すことこそこの仕組みが無くそうとしている失敗形態の再現だからです。
- **認証情報はエンドポイントを伴う必要があります**。さもないとエンドポイント判定が、実際には使えない key を
  通してしまいます：`hasCodexSearchCredentials()` は `api.openai.com` を要求し、DeepSeek 経路は自前で
  エンドポイントを導出します（`getDeepSeekSearchEndpoint()`、**意図的にメインループの wire を見ません**）。
- **`CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0` は固定より優先されます**。あのスイッチはこのエンドポイントを名指し
  しており、固定は「どの認証情報を使うか」を言うだけで、「ユーザーが切った能力を無視する」ものではありません。
- **key は決して描画しません**。パネルは接続済みバッジに `· pinned` を付けるだけで、値も先頭数文字も長さも
  表示しません。
- **ミラーされた値は拒否します**。ある provider の名前を持つ環境変数は、その provider の key である証拠には
  なりません —— DeepSeek 線は DeepSeek の key を `ANTHROPIC_API_KEY` へ、OpenCode セッションは 1 時間で失効する
  OAuth access token を lane に応じて `ANTHROPIC_API_KEY` か `OPENAI_API_KEY` へミラーします。判定は各ミラー
  自身の記帳（`isDeepSeekMirroredApiKey` / `isOpencodeMirroredApiKey` / `isOpencodeMirroredOpenAIApiKey`）で
  行い、値の形から推測しません。
- **固定可能なソースとは、リクエスト層に認証情報の差し込み口があるソースのことです**。その一覧が
  `PINNABLE_SEARCH_SOURCES` であり、`pinSearchCredential` は一覧外のソースを拒否します
  （`UnpinnableSearchSourceError`）——ディスクから出ない key を受け取るくらいなら拒否する、という判断で、
  それがレジストリの防ごうとしている「接続済みなのに空しか返せないソース」です。現在は 4 家族すべてが該当し、
  最後に入ったのが `codex` です。前提は `createOpenAIResponsesStream` に後述の任意パラメータ `credential` が
  追加されたことです。

固定した認証情報は、表示だけでなく**実際に送信されます**：

| ソース | 固定後の経路 |
| --- | --- |
| `anthropic` | `AnthropicDirectSearchAdapter` が独立した `fetch` に切り替わり、`x-api-key` で `<固定したエンドポイント>/v1/messages` へ。`getAnthropicClient()` は使いません —— あのクライアントは `ANTHROPIC_*` 環境変数から組み立てられ、プロファイル切替後はそこに他 provider のミラーされた token とゲートウェイが入っていることがあります |
| `deepseek` | `resolveDeepSeekSearchEndpoint()` が固定したエンドポイントと key を優先して返す |
| `gemini` | `streamGeminiGenerateContent({ apiKey, baseURL })`。`usesAntigravityRoute()` は明示的な apiKey があれば道を譲る（既存の `accessToken` と同じ規則） |
| `codex` | `createOpenAIResponsesStream({ credential })` —— メインループが決して渡さない任意パラメータで、渡さなければリクエストは追加前とバイト単位で同一です。`shouldUseChatGPTAuth()` は明示的な key があれば道を譲る（Gemini と同じ規則） |

`codex` に固有の点が 3 つあります：

- **認証情報は 2 つのパラメータではなく 1 つのオブジェクトです**。key と、それが認証する相手のエンドポイントは、
  一緒に渡すか、まったく渡さないかのどちらかです。エンドポイント側だけ `OPENAI_BASE_URL` にフォールバック
  させていたら、その後 DeepSeek に向け直されたセッションで、固定した OpenAI の key が DeepSeek へ送られて
  いました。したがって「エンドポイントを持たない固定」は OpenAI 自身の既定値を意味し、「環境変数が言っている
  もの」では決してありません。
- **`api.openai.com` の規則は保存されたエンドポイントに適用されます**。`hasCodexSearchCredentials()` はまず
  固定を見て、**その固定自身の** base URL を判定します。そのため OpenAI 互換ゲートウェイを指す固定では行は
  灰色のままになり、リクエストを受理して検索まで走らせながら引用を 1 件も返さない経路が点灯することは
  ありません。`S` はそもそもそのような固定を作りません。この判定は手で編集されたファイル向けです。
- **固定後はモデルを選び直します**。固定はこの経路のエンドポイントをセッションのそれから切り離すため、
  メインループのモデルが api.openai.com の知らないものであり得ます（`deepseek-v4-flash` → 400、集約器が
  握りつぶす）。GPT 系でない id は安価な段へ差し替え、ユーザーが明示的に設定した OpenAI モデルは維持します。

### 4.1.2 自動固定（`services/search/autoPin.ts`）

**固定は既定で自動であり、`S` は手動側の半分にすぎません。** 上の仕組み自体に問題はなく、問題は
**それを押すよう促すものが何もない**ことでした。ウェブ検索が鍵なしのスクレイピング経路へ退化するのは
構造上ずっと無言です（ツールは答え続け、質だけが落ちる）。したがって「このパネルを開こう」と思う瞬間は
永遠に訪れません。被害の前に発見されなければ効かない対処は、その失敗形態に対する対処ではありません。

**4 つの契機**（5 つ目は増やしません）：起動時 prefetch（`src/cli/program/prefetch.tsx`）、パネルの mount、
パネルの `R`、provider ウィザードの保存成功後。共通しているのは「その時点で環境が、各経路が実際に使っている
認証情報を確実に保持している」ことです。これより早い地点（`init()` / `setup()`）は
`applyConfigEnvironmentVariables()` と DeepSeek/OpenCode のミラー確定より前に走るため、
ミラーされた他社の秘密鍵を自社のものとして読み取ってしまいます。

- **何が認証情報かを自分では判断しません**。key 側はすべて `captureSearchCredentialFromEnvironment` を通るため、
  4.1.1 に挙げた拒否条件（ミラー値、非公式エンドポイント、差し込み口のないソース）をそのまま継承し、
  緩い規則を作り直すことはありません。「環境に固定できるものが何もない」がほとんどのセッションの結果であり、
  それはエラーではなく no-op です。
- **内容が変わらなければ書きません**。key とエンドポイントが既存の固定と一致していれば `pinnedAt` すら
  動かしません。この処理は毎回の起動で走るので、毎回時刻を書き換えるファイルの mtime は何も語らなくなります。
  ログインの複製も同じ理由で生バイトを比較します。
- **決して reject しません**。呼び出し側はすべて `void autoPinSearchCredentials()` か素の `.then()` で、
  下流に付けられる `.catch` はありません ——「reject しない」はこのモジュールの契約です。`async` 関数の
  **最初の await より前**に投げられたものも promise の reject になるため、try は settings 読み取りを含む
  関数本体全体を包みます。
- **オプトアウトは `settings.webSearchAutoPin.<ソース>: false`**。パネルの `D` だけが書き込み、明示的な
  「いいえ」のみを保存します（項目がなければ既定＝固定する）。`S` はその取り消しで、`true` を書くのではなく
  キーを削除します。1 つのスイッチが key とログイン複製の両方を覆うのは、それが「このソース」についての
  表明だからです。分割すると `D` の意味が、その行がたまたま表示していた認証情報の種類に依存してしまいます。

### 4.1.3 OAuth ログインの複製（`services/search/oauthCopies.ts`）

**問題**：`gemini`（Antigravity / Google OAuth）と `codex`（ChatGPT OAuth）は key を一切使わずに認証できます。
その認証情報は occ 自身の 0600 の認可ファイルです。`/provider use` はそれらに届きませんが、
**`/logout` は削除します**（`removeChatGPTAuth()` / `removeAntigravityAuth()`）。削除後、検索は同じように
無言で鍵なし経路へ退化します —— 4.1.1 と同じ失敗形態の、認証情報の種類違いです。そして固定ストアは
key しか保持できません：`captureCredential.ts` は access token を拒否します。1 時間で失効するため、
複製したところで 1 時間後には死んだ秘密になるからです。

**対処**：保つ価値があるのは access token ではなく**そのファイル**です。refresh token を持っているのは
ファイルの方だからです。したがって「OAuth の固定」とは、認可ファイルを丸ごと検索専用の 1 部として複製すること、
schema は主ファイルとバイト単位で同一です。

| 項目 | 値 |
| --- | --- |
| パス | `occConfigPath('search-oauth-chatgpt.json')` / `occConfigPath('search-oauth-antigravity.json')` |
| 権限 | `0600`、`writePrivateFileAtomic` による原子的書き込み（`copyFile` ではありません。あれは元ファイルの mode を引き継ぎ、原子的な rename も行いません） |
| 形状 | 元ファイルと**完全に同一**。複製そのものだからです |
| 目印 | **複製ファイルの存在そのもの**が「固定済み」を意味します。`search-credentials.json` の形式は 1 バイトも変えておらず、v2 もありません |

**各経路の認証チェーン**（上位から）：

1. **固定した key**（4.1.1）。明示的な key は OAuth 経路を完全に降ろします
   （`shouldUseChatGPTAuth` / `usesAntigravityRoute` は明示的な認証情報を見ると道を譲ります）。
2. **主ログインファイル**。ログインが存在する間は構造上これが最も新しい —— provider 側がリクエストごとに
   更新するため、複製がこれを上回ってはなりません。
3. **複製**。主ファイルが消えて初めて到達します。それはまさに `/logout` の挙動であり、
   この仕組みが存在する理由そのものです。
4. **環境変数の key**（`OPENAI_API_KEY` / `GEMINI_API_KEY`）。

`codex` には 5 段目 `~/.codex/auth.json`（公式 Codex CLI 自身のファイル）があり、**複製より後**、かつ
**読み取り専用**です。後ろに置くのは、複製が「検索がどのアカウントを使うか」という明示的な記録であるのに対し、
あちらは「このマシンにたまたま別のツールが入っている」というだけだからです。あれが固定を上回ると、
パネルの表示アカウントとリクエストの実アカウントが食い違います。読み取り専用なのは、それが別の CLI のもの
（隔離不変式）であり、またその更新結果を occ 自身のログインファイルへ書くこと —— provider 側はまさにそうします ——
がログアウト済みのアカウントをディスクへ書き戻すことになるからです。

自明ではないが要となる規則：

- **複製の更新は複製にだけ書き戻し、主ファイルには決して書きません**。さもなければ `/logout` の後の
  検索側 token 更新 1 回で provider 側のログインが復活し、ログアウトがログアウトでなくなります。
  実装は「読み出したファイルへ書き戻す」です：`chatgptAuth.ts` は `persistTo` を持つ 2 つのソース表
  （`providerAuthSources` / `searchAuthSources`）を持ち、Antigravity の
  `refreshAndPersist(tokens, fetchImpl, path)` も path 駆動です（projectId の補完も同様）。
- **逆方向も同じです：provider 側の入口は複製を読めません**。`getValidChatGPTAuth()` と
  `getValidAntigravityAuth()` は主ファイルだけを見ます。検索側は `getValidChatGPTAuthForSearch()` と
  `getValidAntigravitySearchAuth()` を通り、`createChatGPTResponsesStream({ authPlane: 'search' })` /
  `streamGeminiGenerateContent({ antigravityAuthPlane: 'search' })` が選択します。
  provider 側が複製へ fall through できるなら、`/logout` は何もログアウトしていないことになります。
- **Antigravity の並行更新の重複排除キーは「(ファイル, refresh token)」であり、素の refresh token では
  ありません**。複製直後の両ファイルは**同一の** refresh token を持ちながら、独立した 2 つの認証情報・
  2 つの書き込み先です。token だけを鍵にすると、一方の更新が他方の promise を受け取り、片方のファイルしか
  更新されません。同一性検査も path 単位で読みます。
- **判定は複製を「接続済み」に数えます**。`hasStoredChatGPTAuthSync`/`Async`、`getStoredChatGPTAccountId`、
  `hasGeminiOAuthCredentialsSync` はいずれも複製を含みます —— これらの呼び出し側はすべて検索側であり、
  そこでは複製こそが経路が実際に使う認証情報だからです。アカウント名は経路自身の解決順で読むので、
  `/logout` の後もパネルは灰色にならず、検索が実際に使っているアカウントを表示し続けます。
- **パネルのバッジ `· pinned` は両方の認証情報で同義です**。ユーザーの問いは「これは `/logout` の後も残るか」
  であり、答えが背後の種類に依存すべきではありません。したがって `D` は**両方を削除します**。
  複製を残すと、固定を消した直後に行が再び「固定済み」と描画され、ユーザーが今削除したはずの認証情報で
  検索を続けてしまいます。
- **`anthropic` / `deepseek` に複製できるログインはありません**。Claude サブスクリプションのログインは
  システム keychain のレコード（隔離不変式の第 1 条）であり、keychain 項目をファイルへ複製するのは
  固定ではなく保管の格下げです。よって `SEARCH_OAUTH_FAMILIES` は上記 2 ソースだけです。
- **`/logout` は複製も明示します**。存続一覧は 2 つのストアを両方読みます。残っていると最も予想されにくいのが
  ログイン複製なので、なおさら言う必要があります。

### 4.2 集約規則（`adapters/aggregateAdapter.ts`）

- 現在のメインループ provider に対応するソースが**主経路**になり、その結果を先頭に置く。それ以外の有効なソースは**拡張経路**として、主経路にない URL だけを補う。同じ認証情報からは 1 経路だけを送信する（メインループが Gemini なら gemini の拡張経路は送信しない）
- すべてを並列で開始する。主経路が戻った後、拡張経路には短い猶予（`ENHANCER_GRACE_MS`、2s）だけを与え、タイムアウトした結果は破棄する。遅いスクレイピングでユーザーが余計に待つ時間は最大 2 秒であり、検索全体を停滞させない
- 主経路が失敗または空なら、拡張経路を**最後まで待つ**（拡張対象がない場合は、それらが回答になる）
- 単一経路の失敗は黙って無視し、**すべての経路が失敗**した場合だけツールへエラーを投げる
- 正規化した URL（fragment、utm/gclid などの追跡パラメータ、末尾のスラッシュを除去）で重複を排除し、総数は `num_results`（デフォルト 8）を上限とする
- Gemini の grounding URL は `vertexaisearch.cloud.google.com/grounding-api-redirect/…` というリダイレクトラッパーなので、まず HEAD のリダイレクト追跡で実際の URL を解決してから、重複排除とドメインフィルタを行う

**主経路 / 拡張経路は並び順だけではなく、リクエストの送信方法も決定します**。provider 系の各ソースはそれぞれ異なる方式を使います。

| ソース | 主経路 | 拡張経路 |
| --- | --- | --- |
| `anthropic` | セッション自身の query パイプライン（`ApiSearchAdapter`）を通す | 独立した Messages 呼び出し（`AnthropicDirectSearchAdapter`）。パイプラインはリクエストを現在の provider へルーティングするため、拡張経路では使えない |
| `deepseek` | 同上（パイプラインが元から DeepSeek を指している） | 自分でエンドポイントを解決する独立呼び出し（`DeepSeekDirectSearchAdapter`）。どの wire でも動く |
| `gemini` | `GEMINI_AUTH_MODE` に基づいて公開エンドポイントか Antigravity を選ぶ | Google ログインがあれば Antigravity を使う |
| `codex` | `OPENAI_AUTH_MODE` に基づいて API key か ChatGPT OAuth を選ぶ | 接続済みの ChatGPT アカウントを優先し、未ログインの場合だけ API key へフォールバックする |

`brave` / `exa` / `free` はこの表に含まれません。いずれも特定の provider 固有の検索層ではないため
`primarySourceId()` が選ぶことはなく、拡張経路という形態しか持ちません（key 1 つ、エンドポイント 1 つ、
構築 1 通り）。

**Gemini のモデルはルートに合わせる必要があります**。Antigravity バックエンドは固有の model id（`gemini-3.1-pro-low` /
`gemini-3.1-flash-lite` / `gemini-pro-agent`）だけを提供し、公開 id はすべて 404 `Requested entity was not found` を返します。
そのため検索 lane はルートに応じてデフォルトモデルを選び（Antigravity は flash-lite、公開エンドポイントは `gemini-2.5-flash`）、
公開用の `GEMINI_MODEL` をそのまま Antigravity へ転送することも**ありません**。

### 4.3 明示指定（集約をスキップ）

`WEB_SEARCH_ADAPTER` 環境変数 > `settings.webSearchAdapter` の順で優先し、値は
`api|codex|deepseek|gemini|free|bing|brave|exa` です。一致した場合は**そのソースだけ**を実行します。
認識できない値（削除済みの `tavily` など）は、何も表示せずにデフォルトの集約へフォールバックします。

ソースの明示指定は、そのソースをセッションの provider にするものではありません。`api`/`gemini`/`codex` は引き続き 4.2 の表に従って主経路か拡張経路かを決定します。

`bing` の入口はこれだけです（レジストリには入りません。理由は 4.1）。`brave` と `exa` は key を設定すれば
自動的に集約へ参加するため、明示指定の用途は**そのソースだけを使いたい場合**に限られます。他を止めずに
追加したいなら、key を設定するだけで十分です。

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
