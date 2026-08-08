# Open Claude Code (occ)

[![GitHub Stars](https://img.shields.io/github/stars/sweetcornna/open-claude-code?style=flat-square&logo=github&color=yellow)](https://github.com/sweetcornna/open-claude-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/sweetcornna/open-claude-code?style=flat-square&color=orange)](https://github.com/sweetcornna/open-claude-code/issues)
[![Last Commit](https://img.shields.io/github/last-commit/sweetcornna/open-claude-code?style=flat-square&color=blue)](https://github.com/sweetcornna/open-claude-code/commits/main)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)

> 公式 Claude Code と共存できる、オープンソースのターミナル AI コーディングアシスタント。

[English](./README.md) · [简体中文](./README.zh.md) · **日本語**

**open-claude-code**（`occ`）は Anthropic の [Claude Code](https://docs.anthropic.com/en/docs/claude-code) を完全に復元した実装で、Goal による継続実行、マルチエージェント編成、Artifacts、ACP 対応を追加しています。さらに**公式 Claude Code から完全に分離**されているため、同じマシンに両方をインストールしても干渉しません。

## 公式 Claude Code からの分離

これが他のフォークとの最大の違いです。分離前のフォークは `~/.claude`、`~/.claude.json`、キャッシュツリー、**そして同じ macOS キーチェーンのエントリ**を共有していたため、どちらかの CLI にログインすると相手側の OAuth トークンを上書きしてしまいました。現在は次のように分かれています。

| | open-claude-code | 公式 Claude Code |
| --- | --- | --- |
| ユーザー設定 | `~/.occ/` | `~/.claude/` |
| グローバル状態 | `~/.occ.json` | `~/.claude.json` |
| プロジェクト資産 | `.occ/` | `.claude/` |
| キャッシュ | `~/.cache/occ-nodejs/` | `~/.cache/claude-cli-nodejs/` |
| 資格情報（macOS） | `Open Claude Code-credentials-<hash>` | `Claude Code-credentials` |
| エンタープライズポリシー | `/etc/occ`、`win.open-claude-code.occ` | `/etc/claude-code`、`com.anthropic.claudecode` |
| 環境変数による上書き | `OCC_CONFIG_DIR` | `CLAUDE_CONFIG_DIR`（引き続き有効） |

**意図的に共有しているもの:** `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` というメモリファイル名は変更していません。これらはツールをまたいだ共通の慣習であり、名前を変えると既存のすべてのリポジトリでコンテキストが失われるためです。子プロセスには従来どおり `CLAUDECODE=1`（多くのユーザーフックスクリプトがこれを判定に使っています）に加えて `OCC=1` を渡します。IDE のロックファイルは両方のルートから探します。マーケットプレイスの拡張機能は Anthropic 製で `~/.claude/ide` に書き込むためです。

### 公式 Claude Code からの移行

```sh
occ migrate --dry-run          # 何がコピーされるかを表示
occ migrate                    # 実行（シークレットは除外）
occ migrate --with-credentials # ログイン情報も引き継ぐ
```

どちらのモードでも**コピーされる対象は同じ**です（settings、skills、agents、commands、output-styles、workflows、plugins、rules、MCP サーバー定義）。違いはシークレットを一緒に持っていくかどうかだけです。初回起動ウィザードでも同じ 3 つの選択肢が提示されます。

- **既定（資格情報なし）:** OAuth トークン、API キー、`settings.env` のシークレット部分、MCP の `env` / `headers`、およびコマンドを実行して資格情報を解決する `apiKeyHelper` / `awsAuthRefresh` / `awsCredentialExport` / `gcpAuthRefresh` / `otelHeadersHelper` フックを除外します。**ルーティング設定は保持されます**: `*_BASE_URL`、`*_MODEL`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_USE_*`、`*_AUTH_MODE`、および `CLAUDE_CODE_CLIENT_CERT` / `CLAUDE_CODE_CLIENT_KEY` のような証明書の*パス*（パスはシークレットではなく、mTLS のペアは片方だけでは無意味です。除外されるのは `..._PASSPHRASE` のみ）。除外された項目は、書き込みの前にすべて名前付きで一覧表示されます。
- **`--with-credentials`:** 上記に加えて OAuth トークン、レガシー API キー、`~/.claude.json` 内のアカウントキー（`primaryApiKey`、`oauthAccount`、`customApiKeyResponses`、`workspaceApiKey`）もコピーするため、`/login` をやり直さずに occ が使えます。**注意:** サーバーは OAuth リフレッシュトークンをローテーションし、両方の CLI が同じものを保持することになるため、先にリフレッシュしたほうがもう一方を無効化します。日常的に使うほうを 1 つ選んでください。
- 既定モードで実行した後に気が変わった場合は、`occ migrate --with-credentials` でログイン情報を追加し、初回に除外された `settings.json` のシークレットも復元できます。不足している値だけを埋め、occ 側で変更済みの値を上書きすることはありません。`.migrated` マーカーがどのカテゴリを実行したかを記録するため、締め出されることはありません。
- `--skip-account-data` / `--no-account-data` は 2.9 より前の書き方で、現在は既定モードと同じ意味です。
- 2 か所だけはそのままコピーされ、**レポートに名前が出ます**。分類する手段がないためです: `settings.json` の `pluginConfigs` と `plugins/` 配下のファイルです。プラグインが `sensitive` と宣言したフィールドはセキュアストレージにあり、このモードは決して触れませんが、その切り分けは各プラグインのマニフェスト任せなので、残りは自分で確認してください。

**セッション履歴は決してコピーされません。** 資格情報のコピーは一方向かつ no-clobber です。既存の occ のログインが常に優先され、公式のキーチェーンエントリが変更されることはありません。`~/.claude` は全工程を通じて読み取り専用で、そこに書き込み・移動・削除は一切行いません。

## クイックスタート（公開パッケージ）

```sh
npm i -g @sweetcornna/open-claude-code

occ           # Node.js で実行
occ-bun       # Bun で実行
occ update    # 最新版に更新
```

> **スコープは必須です。** npm 上のスコープなし `open-claude-code` は本プロジェクトではなく、
> 第三者が取得した `0.0.0` のプレースホルダです。`bin` を持たないため
> `npm i -g open-claude-code` は成功したように見えて（`added 1 package`）、
> `occ` コマンドは一切インストールされません。

> 2.8 より前の `ccb` / `ccb-bun` という名前は削除されました。まだ使っているスクリプトは `occ` / `occ-bun` に移行してください。

## クイックスタート（ソースから）

### 必要環境

Bun は最新版を使ってください。古いバージョンでは不可解な不具合が多発します。

- [Bun](https://bun.sh/) >= 1.3.11

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# インストール済みの場合
bun upgrade
```

### インストールと実行

```bash
cd /path/to/open-claude-code
bun install

bun run dev      # 開発モード
bun run build    # ビルド
```

ビルドはコード分割を使用します。成果物は `dist/` に出力され、Bun と Node.js の両方で動作します。

### 初回の `/login`

REPL で `/login` を実行し、**Anthropic Compatible** を選ぶと、Anthropic アカウントなしで任意の互換サービスを利用できます。OpenAI、Gemini、Grok にはそれぞれ専用の項目があります。

| フィールド | 説明 | 例 |
| --- | --- | --- |
| Base URL | API エンドポイント | `https://api.example.com/v1` |
| API Key | 認証キー | `sk-xxx` |
| Haiku Model | 高速モデルの ID | `claude-haiku-4-5-20251001` |
| Sonnet Model | バランス型モデルの ID | `claude-sonnet-5` |
| Opus Model | 高性能モデルの ID | `claude-opus-5` |
| Fable Model | 最上位モデルの ID | `claude-fable-5` |

**Tab / Shift+Tab** でフィールドを移動、**Enter** で確定し、最後のフィールドで Enter を押すと保存されます。

## 主な機能

| 機能 | 説明 | ドキュメント |
| --- | --- | --- |
| **Goal による継続実行** | `/goal <objective>` で目標を設定すると、完了までターンをまたいでエージェントを駆動します。トークン予算、completion/blocked の監査、`pause`/`resume`/`continue`/`clear` 付き | [`src/commands/goal/`](./src/commands/goal/) |
| **Ultracode マルチエージェント編成** | `/ultracode` と `Workflow` ツールで決定論的な JS スクリプト（`agent`/`pipeline`/`parallel`/`phase`）を実行。`/workflows` でライブパネルを表示し、ジャーナル再生と同時実行数の上限に対応 | [ドキュメント](./docs/zh/features/workflow-scripts.md) |
| **Artifacts** | モデルが HTML／ダッシュボード／レポートを公開 URL にアップロード（7 日／30 日で失効）。Cloudflare Worker + R2 でセルフホスト可能 | [ドキュメント](./packages/cloud-artifacts/README.md) |
| **ACP プロトコル** | Zed、Cursor などの IDE と接続。セッション再開、Skills、権限のブリッジに対応 | [ドキュメント](./docs/zh/features/acp-zed.md) |
| **Remote Control** | `occ remote-control` は occ 自身の ACP エージェント経由でセッションを [Happy](https://github.com/slopus/happy)（スマートフォン／Web／エンドツーエンド暗号化）に引き渡します。サーバーはセルフホスト可能 | [ドキュメント](./docs/zh/features/remote-control-self-hosting.md) |
| **Langfuse モニタリング** | エージェントループの詳細をすべて確認でき、ワンクリックでデータセット化 | [ドキュメント](./docs/zh/features/langfuse-monitoring.md) |
| **Web 検索** | Bing / Brave による組み込み検索 | [ドキュメント](./docs/zh/features/web-browser-tool.md) |
| **Poor モード** | メモリ抽出と入力サジェストを無効化し、同時リクエストを削減 | `/poor` |
| **Channels** | MCP サーバーが外部メッセージ（Feishu/Slack/Discord など）をセッションに送り込みます | [ドキュメント](./docs/zh/features/channels.md) |
| **カスタムプロバイダー** | OpenAI / Anthropic / Gemini / Grok 互換 | [ドキュメント](./docs/zh/features/all-features-guide.md) |
| ボイスモード | 音声入力（Doubao `/voice doubao` を含む） | [ドキュメント](./docs/zh/features/voice-mode.md) |
| Computer Use | スクリーンショット、キーボードとマウスの操作 | [ドキュメント](./docs/zh/features/computer-use.md) |
| ブラウザ MCP（ユーザー設定） | 通常の MCP 設定で任意のブラウザ MCP を追加できます。`chrome-devtools` や `mcp-chrome` などの名前も予約されていません | [ドキュメント](./docs/ja/extensibility/mcp-configuration.mdx) |
| `/dream` | メモリの自動統合 | [ドキュメント](./docs/zh/features/auto-dream.md) |

## フィーチャーフラグ

`FEATURE_<FLAG_NAME>=1` で有効化します。

```bash
FEATURE_FORK_SUBAGENT=1 bun run dev
```

既定で有効な 33 個のフラグは [`scripts/defines.ts`](./scripts/defines.ts) の `DEFAULT_BUILD_FEATURES` にあります。それ以外は環境変数が必要です。機能ごとの詳細は [`docs/zh/features/`](./docs/zh/features/) にあります。

## VS Code でのデバッグ

TUI（REPL）モードには実際のターミナルが必要なため、**アタッチモード**を使います。

```bash
bun run dev:inspect     # ws://localhost:8888/xxxx を表示
```

`src/` 配下にブレークポイントを設定し、F5 → **"Attach to Bun (TUI debug)"** を選びます。

## 開発

```bash
bun run precheck      # typecheck + lint fix + test — エラーゼロで通す必要があります
bun run typecheck
bun run test
bun run build:vite
```

アーキテクチャ、モジュールマップ、パス／分離の不変条件、テストのルールは [`CLAUDE.md`](./CLAUDE.md) にあります。**パス関連のコードに触れる前に必ず読んでください。**

## 謝辞

- [doubaoime-asr](https://github.com/starccy/doubaoime-asr) — Doubao ASR SDK。Anthropic の OAuth を必要としない音声入力の経路をボイスモードに提供しています
- [free-search-mcp](https://github.com/sweetcornna/free-search-mcp) — ローカル優先、API キー不要の検索 MCP サーバー。WebSearch の `free` ソースは、そのキー不要エンジンプール（DuckDuckGo / Mojeek / Bing）、RRF による統合、SearXNG によるリカバリパスを移植したものです

## ライセンス

本プロジェクトは学習・研究目的のみを対象としています。Claude Code に関するすべての権利は [Anthropic](https://www.anthropic.com/) に帰属します。
