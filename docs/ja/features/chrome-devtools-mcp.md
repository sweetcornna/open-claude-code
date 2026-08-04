<!-- lang-switcher -->
[English](/docs/en/features/chrome-devtools-mcp) · [中文](/docs/zh/features/chrome-devtools-mcp) · **日本語**

# Chrome ブラウザツール（chrome-devtools-mcp）

## 1. 機能概要

occ のブラウザ制御は、Google 公式の [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)（Apache-2.0）が提供します。occ はこれを stdio MCP server として起動し、Chrome DevTools Protocol 経由でブラウザを操作します。

- ページの一覧表示/切り替え/新規作成/終了、前後への移動
- クリック、入力、ドラッグ、フォーム入力、ファイルアップロード、ダイアログ処理
- ページのアクセシビリティスナップショット（`take_snapshot`）とスクリーンショット
- コンソールメッセージとネットワークリクエストの読み取り
- performance trace と Lighthouse 監査
- デバイスエミュレーションとウィンドウサイズの変更

> **従来の拡張機能方式は削除済みです。** occ は以前、Chrome 拡張機能 + native messaging host による実装を継承していましたが、その経路は公式 Claude Code の host identity しか認識しません。occ へインストールすれば、別製品のブラウザ統合を奪うことになります。そのため、この機能は常に fail-closed であり、`--chrome` はエラーを 1 行表示するだけでした。stdio MCP server へ移行したことで、occ と公式 Claude Code の間に**共有 identity は一切ありません**。これは単に occ 自身が spawn する子プロセスです。

## 2. 前提条件

| 条件 | 説明 |
|------|------|
| Node.js | LTS バージョン。occ は MCP server プロセスの実行に使う |
| Google Chrome | `--autoConnect` には **Chrome 144+** が必要。古いバージョンも利用できるが、空の profile を持つ別のブラウザが開く |
| サブスクリプション | **不要**。ローカルプロセスであり、Anthropic を経由しない |

`chrome-devtools-mcp` は occ の runtime dependency であり、npm package とともにインストールされます。拡張機能の個別インストールや native host の登録は不要です。実行時に依存関係を解決できなければ、occ は `npx -y chrome-devtools-mcp@latest` へフォールバックします。

## 3. 有効化方法

```bash
# Dev モード
bun run dev -- --chrome

# ビルド成果物
node dist/cli.js --chrome

# 無効化
occ --no-chrome
```

次の方法も利用できます。

- `CLAUDE_CODE_ENABLE_CFC=1` 環境変数を設定する
- `/config` パネルで「Chrome browser tools enabled by default」を有効にする（`chromeDevtoolsDefaultEnabled` へ書き込む）

優先順位は `--chrome` / `--no-chrome` > `CLAUDE_CODE_ENABLE_CFC` > `chromeDevtoolsDefaultEnabled` で、デフォルトは無効です。**非対話セッション（SDK / CI / `-p`）ではデフォルトで有効になりません**。明示的に `--chrome` を渡した場合だけ有効になります。CI で知らないうちにブラウザを起動することを望む利用者はいないためです。

REPL では `/chrome` で現在の状態を確認できます。Chrome のバージョン、接続モード、接続の有無、デフォルト設定が表示されます。

## 4. 接続モード

### autoConnect（デフォルト）

ユーザーが**すでに起動している** Chrome に接続し、新しくログインが必要な空のブラウザを開くのではなく、実際の profile とログイン状態を使います。

要件:

- Chrome 144 以降
- 対象の Chrome で `chrome://inspect/#remote-debugging` からリモートデバッグを有効にする

バージョンが足りない場合、`chrome-devtools-mcp` 自身が一時 profile を持つブラウザを起動します。ページは開きますが、すべてのサイトがログアウト状態です。この失敗は何も表示されないため、`occ doctor` が事前に説明します。

### browser-url（WSL / リモート / コンテナ）

`OCC_CHROME_BROWSER_URL` を設定すると、occ は `--browserUrl` で接続します。

```bash
# Windows 側で Chrome を起動
chrome.exe --remote-debugging-port=9222

# WSL 側
export OCC_CHROME_BROWSER_URL=http://127.0.0.1:9222
occ --chrome
```

WSL で利用できるのはこの経路だけです。Chrome は Windows にインストールされており、Linux namespace には操作対象のブラウザが存在しないためです。リモートデスクトップやコンテナでも同じ方法を利用できます。

### server 自身にブラウザを起動させる

`OCC_CHROME_AUTOCONNECT=0` を設定して `--autoConnect` を渡さず、`chrome-devtools-mcp` 自身に Chrome を起動させます。agent に自分のログイン状態へ触れさせたくない場合に適しています。

## 5. 権限モデル

ツールの完全名は `mcp__chrome-devtools__<tool>` という形式で、**他の MCP server とまったく同じ権限フロー**を通ります。ただし、例外が 1 つあります。

**確認不要（読み取り専用の観測系、合計 9 個）**

`take_snapshot`、`take_screenshot`、`list_pages`、`list_console_messages`、`get_console_message`、`list_network_requests`、`get_network_request`、`performance_analyze_insight`、`wait_for`

**確認が必要（その他すべて）**

`click`、`drag`、`fill`、`fill_form`、`hover`、`press_key`、`type_text`、`upload_file`、`handle_dialog`、`navigate_page`、`new_page`、`close_page`、`select_page`、`emulate`、`resize_page`、`evaluate_script`、`performance_start_trace`、`performance_stop_trace`、`lighthouse_audit`、`take_heapsnapshot`

境界は「ブラウザの状態を変更するか」です。通常、このツール群が操作するのはユーザー**本人のログイン済み**ブラウザなので、クリック、入力、ナビゲーション、スクリプト実行はすべて事前確認が必要です。`chrome-devtools` skill の `allowedTools` は意図的に同じ読み取り専用リストを使っています。skill の `allowedTools` は always-allow 規則になるため、操作系ツールを含めると、このゲートを密かに取り外すことになります。

## 6. telemetry

occ は `chrome-devtools-mcp` の upstream telemetry をデフォルトで無効にし、Google が公式にサポートする 2 種類の設定を両方使っています。

- コマンドラインの `--no-usage-statistics`
- 環境変数 `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`、`CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`

occ がユーザーに代わって第三者へ利用統計を送信することはありません。

## 7. 診断

`occ doctor` は次のように報告します。

```
└ Chrome (--chrome): 144.0.7204.50 (autoConnect)
```

問題がある場合は、対処方法を 1 行で表示します。例:

- `Chrome not found. Install Google Chrome, or set OCC_CHROME_BROWSER_URL ...`
- `Chrome 138.x is below 144, so --autoConnect cannot attach to it. A separate browser with an empty profile will be launched instead (no logins).`
- `WSL detected. Chrome on the Windows side is not reachable from here — start it with --remote-debugging-port=9222 and set OCC_CHROME_BROWSER_URL=http://127.0.0.1:9222`

## 8. よくある問題

### ツールがツール一覧に表示されない

起動時に `--chrome` を付けたことを確認し、`/mcp` で `chrome-devtools` が connected になっているか確認してください。ツール検索（`EXPERIMENTAL_SEARCH_EXTRA_TOOLS`）が有効な場合、MCP ツールは遅延読み込みされます。モデルはまず `SearchExtraTools` でツールを取得する必要があり、その手順は system prompt に記載されています。

### 接続できたが、すべてのサイトがログアウト状態になる

`--autoConnect` が接続できず、`chrome-devtools-mcp` が一時 profile の別ブラウザを開いています。`occ doctor` を実行し、Chrome のバージョンが 144 以上か、`chrome://inspect/#remote-debugging` でリモートデバッグが有効になっているか確認してください。

### WSL から接続できない

前述の browser-url セクションを参照してください。通常、WSL の Linux 側には Chrome 自体がインストールされていません。

### ブラウザ機能を使わない場合

`--chrome` を付けずに通常どおり起動すれば、ブラウザ関連のプロセスは spawn されません。

## 9. 関連ドキュメント

- upstream repository とツールリファレンス: https://github.com/ChromeDevTools/chrome-devtools-mcp
- `docs/zh/features/chrome-use-mcp.md` は**別のもの**を説明しています。サードパーティの `hangwin/mcp-chrome`（デフォルトで登録されるが無効になっている `mcp-chrome` HTTP server、ポート 12306）であり、本文とは無関係です。
