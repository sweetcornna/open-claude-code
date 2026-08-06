<!-- lang-switcher -->
[English](/docs/en/features/browser-use) · [中文](/docs/zh/features/browser-use) · **日本語**

# ブラウザツール（browser-use）

## 1. 概要

occ のブラウザ制御は [`browser-use`](https://github.com/browser-use/browser-use) が提供します。occ が stdio MCP server として起動し、実際の Chrome/Chromium を操作します。

- ページ状態の取得（`browser_get_state`）—— ページに何があり、どれが操作可能か
- コンテンツ抽出（`browser_extract_content`）—— 構造ではなく情報が欲しいときに使う。生の状態を推論するよりはるかに安い
- ナビゲーション、クリック、入力、スクロール、戻る
- タブとセッションの管理
- `retry_with_browser_use_agent` —— タスク全体を自律ブラウジング agent に委ねる

> **以前は chrome-devtools-mcp を使っていましたが、削除しました。** あちらは生の DevTools 面（ネットワークリクエスト、コンソール、パフォーマンストレース、Lighthouse）を公開していました。今回のトレードは、それらの DevTools 固有機能と引き換えに意味的な操作を得ることです。前者に依存している場合、このリリースは適しません。

## 2. 前提条件

| 条件 | 説明 |
|---|---|
| `uvx` | **必須**。browser-use は Python ツールです。[uv](https://docs.astral.sh/uv/getting-started/installation/) をインストールしてください |
| Chrome / Chromium | **必須**。browser-use は実ブラウザを操作します |
| モデル認証情報 | 次節参照。OAuth ログインなら設定不要です |
| サブスクリプション | **不要**。ローカルプロセスであり、Anthropic を経由しません |

`--chrome` は事前に `uvx` を検出し、無ければインストール先を示して終了します —— 素の ENOENT を MCP 層に投げても、ユーザーには手がかりになりません。

## 3. 認証情報

browser-use は自前のモデル呼び出しを行う（自律 agent と抽出パス）ため、独自の認証情報が要ります。occ が自動で処理します。

- **API key でログイン**：環境に `ANTHROPIC_API_KEY` または `OPENAI_API_KEY` があり、子プロセスがそのまま継承します。occ は手を加えません。
- **OAuth でログイン**：環境に key は無く、keychain の access token だけがあります。occ はそれを `ANTHROPIC_AUTH_TOKEN`（Anthropic SDK の bearer 変数）として渡します。

明示的に設定した変数が上書きされることはありません。

## 4. 有効化

| 方法 | 説明 |
|---|---|
| `occ --chrome` | このセッションで有効化 |
| `occ --no-chrome` | このセッションで強制的に無効化（最優先） |
| `CLAUDE_CODE_ENABLE_CFC=1` | 環境変数で有効化 |
| `/chrome` パネル | 状態確認、「デフォルトで有効」の切り替え |
| 設定キー `browserToolDefaultEnabled` | 永続的なデフォルト（旧キー `chromeDevtoolsDefaultEnabled` も読みます） |

非対話セッション（SDK、CI、`-p`）では、明示的に `--chrome` を渡さない限り無効です。

## 5. 権限

権限プロンプトをスキップする**観察系**ツールは 4 つだけです。

`browser_get_state`、`browser_extract_content`、`browser_get_html`、`browser_screenshot`、`browser_list_tabs`、`browser_list_sessions`

それ以外はすべて通常の MCP 権限フローを通ります —— 多数のステップを自律的に実行する `retry_with_browser_use_agent` は特にです。

このゲートは意図的なものです。操作対象は実際の、ログイン済みかもしれないブラウザだからです。

## 6. トラブルシューティング

| 症状 | 原因 |
|---|---|
| `browser tools need \`uvx\`` | uv が未インストール。前提条件を参照 |
| server 起動後、最初の呼び出しで認証エラー | browser-use がモデル認証情報を取得できていない。ログイン状態を確認するか `ANTHROPIC_API_KEY` を自分で設定 |
| ブラウザが見つからないと報告される | Chrome/Chromium が未インストール。`occ doctor` が検出結果を表示します |
| ツール名を呼び出せない | ツール検索が有効な場合 MCP ツールは遅延ロードです。先に SearchExtraTools で `mcp__browser-use__*` をロードしてください |

## 7. 参考

- upstream repository: https://github.com/browser-use/browser-use
- MCP server ドキュメント: https://docs.browser-use.com/customize/mcp-server
