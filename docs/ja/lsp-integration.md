<!-- lang-switcher -->
[English](/docs/en/lsp-integration) · [中文](/docs/zh/lsp-integration) · **日本語**

# LSP インテグレーション

Claude Code は Language Server Protocol (LSP) インテグレーションを内蔵し、コードインテリジェンス機能（定義へ移動、参照を検索、ホバー情報、ドキュメントシンボルなど）と受動的な診断フィードバックを提供します。

## クイックスタート

### 1. LSP プラグインをインストールする

Claude Code REPL で `/plugin` コマンドを使用し、LSP プラグインを検索してインストールします。

```
/plugin
```

`lsp` を検索し、対象言語のプラグイン（`typescript-lsp` など）を見つけてインストールを選択します。

インストール後に `/reload-plugins` を実行し、プラグインを有効にします。

LSP プラグインをインストールすると、バックグラウンドの LSP Server Manager が対応する言語サーバーを自動的に読み込んで起動するため、手動設定は不要です。

### 2. LSP Tool を有効にする

Claude がコードインテリジェンスの問い合わせを能動的に実行するには、環境変数で LSP Tool を明示的に有効にする必要があります。

```bash
ENABLE_LSP_TOOL=1 bun run dev
```

有効にしなくても LSP サーバーはバックグラウンドで動作し、型エラーなどの受動的な診断フィードバックを送ります。

## 自動推奨

`/plugin` から手動で検索してインストールする方法に加え、Claude Code はファイルの編集時に次の処理を自動的に実行します。

1. `fileHistory.trackedFiles` を監視し、新しいファイルが編集されたことを検出する
2. インストール済みの marketplace を走査し、そのファイル拡張子への対応を宣言している LSP プラグインを見つける
3. 対応する LSP バイナリ（`typescript-language-server` など）がシステムにインストール済みか確認する
4. 条件を満たす場合は推奨ダイアログを表示し、インストールを選択できるようにする

```
┌───── LSP Plugin Recommendation ─────────────┐
│                                               │
│  LSP provides code intelligence like          │
│  go-to-definition and error checking          │
│                                               │
│  Plugin: typescript-lsp                       │
│  Triggered by: .ts files                     │
│                                               │
│  Would you like to install this LSP plugin?   │
│                                               │
│  > Yes, install typescript-lsp               │
│    No, not now                                │
│    Never for typescript-lsp                   │
│    Disable all LSP recommendations            │
└───────────────────────────────────────────────┘
```

- 30 秒間操作がなければ自動的に閉じる（"No" として扱う）
- "Never" を選ぶと、そのプラグインを以後推奨しない
- "Disable" を選ぶと、すべての LSP 推奨を無効にする
- 5 回連続で無視すると、推奨を自動的に無効にする

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────┐
│                    LSP Tool                         │
│  packages/builtin-tools/src/tools/LSPTool/LSPTool.ts│
│  (Claude が呼び出せるツール、9 種類の操作)             │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              LSP Server Manager (Singleton)          │
│  src/services/lsp/manager.ts                        │
│  - initializeLspServerManager()                     │
│  - reinitializeLspServerManager()                   │
│  - shutdownLspServerManager()                       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│           LSP Server Manager (インスタンス)            │
│  src/services/lsp/LSPServerManager.ts               │
│  - 複数の LSPServerInstance を管理                     │
│  - ファイル拡張子に基づいてリクエストをルーティング          │
│  - ファイル同期 (didOpen/didChange/didSave/didClose)  │
└──────────────────────┬──────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ LSPServer    │ │ LSPServer    │ │ LSPServer    │
│ Instance     │ │ Instance     │ │ Instance     │
│ (typescript) │ │ (python)     │ │ (rust...)    │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
┌──────▼───────┐ ┌──────▼───────┐ ┌──────▼───────┐
│ LSPClient    │ │ LSPClient    │ │ LSPClient    │
│ (JSON-RPC)   │ │ (JSON-RPC)   │ │ (JSON-RPC)   │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
  子プロセス (stdio) 子プロセス (stdio) 子プロセス (stdio)
```

### 受動的な診断フィードバック

```
LSP Server ──publishDiagnostics──▶ passiveFeedback.ts
                                          │
                                          ▼
                                   LSPDiagnosticRegistry
                                   (重複排除、容量制限)
                                          │
                                          ▼
                                   Attachment System
                                   (会話へ非同期に注入)
```

LSP サーバーは `textDocument/publishDiagnostics` 通知を非同期に送ります。通知は重複排除と容量制限を経て、attachment として Claude の会話コンテキストへ注入されます。

## 中核モジュール

| ファイル | 役割 |
|------|------|
| `src/services/lsp/manager.ts` | グローバル singleton。初期化、再初期化、終了のライフサイクルを管理する |
| `src/services/lsp/LSPServerManager.ts` | 複数サーバーの管理、ファイル拡張子に基づくルーティング、ファイル同期 |
| `src/services/lsp/LSPServerInstance.ts` | 個別 LSP サーバーインスタンスのライフサイクル（起動、停止、再起動、ヘルスチェック） |
| `src/services/lsp/LSPClient.ts` | JSON-RPC 通信層（`vscode-jsonrpc` ベース）と子プロセス管理 |
| `src/services/lsp/config.ts` | プラグインから LSP サーバー設定を読み込む |
| `src/services/lsp/LSPDiagnosticRegistry.ts` | 診断情報の登録、重複排除、容量制限 |
| `src/services/lsp/passiveFeedback.ts` | `publishDiagnostics` 通知ハンドラーを登録する |
| `packages/builtin-tools/src/tools/LSPTool/LSPTool.ts` | Claude に公開する LSP Tool の実装 |
| `packages/builtin-tools/src/tools/LSPTool/schemas.ts` | 入力 schema（9 種類の操作からなる discriminated union） |
| `packages/builtin-tools/src/tools/LSPTool/formatters.ts` | 各操作の結果を整形する |
| `packages/builtin-tools/src/tools/LSPTool/prompt.ts` | Tool の説明テキスト |
| `src/utils/plugins/lspPluginIntegration.ts` | プラグインからの読み込み、検証、環境変数の解決、スコープ管理 |

## LSP Tool がサポートする操作

| 操作 | LSP Method | 説明 |
|------|-----------|------|
| `goToDefinition` | `textDocument/definition` | シンボルの定義へ移動する |
| `findReferences` | `textDocument/references` | すべての参照を検索する |
| `hover` | `textDocument/hover` | ホバー情報（ドキュメント、型）を取得する |
| `documentSymbol` | `textDocument/documentSymbol` | ドキュメント内のすべてのシンボルを取得する |
| `workspaceSymbol` | `workspace/symbol` | ワークスペース全体のシンボルを検索する |
| `goToImplementation` | `textDocument/implementation` | インターフェースまたは抽象メソッドの実装を検索する |
| `prepareCallHierarchy` | `textDocument/prepareCallHierarchy` | 指定位置のコール階層項目を取得する |
| `incomingCalls` | `callHierarchy/incomingCalls` | この関数を呼び出すすべての関数を検索する |
| `outgoingCalls` | `callHierarchy/outgoingCalls` | この関数が呼び出すすべての関数を検索する |

すべての操作で `filePath`、`line`（1-based）、`character`（1-based）パラメーターが必要です。

## プラグイン開発: LSP サーバー設定

LSP サーバーはプラグインから提供されます。プラグインの `manifest.json` では、次の 3 形式で LSP サーバーを宣言できます。

**1. インライン設定（manifest 内で直接定義）**

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      }
    }
  }
}
```

**2. 外部 .lsp.json ファイルへの参照**

```json
{
  "lspServers": "path/to/.lsp.json"
}
```

**3. 配列による混在形式**

```json
{
  "lspServers": [
    "path/to/.lsp.json",
    {
      "another-server": { "command": "...", "extensionToLanguage": { "...": "..." } }
    }
  ]
}
```

プラグインディレクトリ直下に `.lsp.json` ファイルを配置し、manifest での宣言を省略することもできます。

### LSP サーバー設定 Schema

| フィールド | 型 | 必須 | 説明 |
|------|------|------|------|
| `command` | string | はい | LSP サーバーの実行コマンド（空白を含まない） |
| `args` | string[] | いいえ | コマンドライン引数 |
| `extensionToLanguage` | `Record<string, string>` | はい | ファイル拡張子から言語 ID へのマッピング（1 つ以上） |
| `transport` | `"stdio"` \| `"socket"` | いいえ | 通信方式。デフォルトは `stdio` |
| `env` | `Record<string, string>` | いいえ | サーバー起動時に設定する環境変数 |
| `initializationOptions` | unknown | いいえ | サーバーへ渡す初期化オプション |
| `settings` | unknown | いいえ | `workspace/didChangeConfiguration` で渡す設定 |
| `workspaceFolder` | string | いいえ | ワークスペースディレクトリのパス |
| `startupTimeout` | number | いいえ | 起動タイムアウト（ミリ秒） |
| `maxRestarts` | number | いいえ | 最大再起動回数（デフォルト 3） |

### 環境変数の置換

設定内の `command`、`args`、`env`、`workspaceFolder` では、次の変数を使用できます。

- `${CLAUDE_PLUGIN_ROOT}` — プラグインのルートディレクトリ
- `${CLAUDE_PLUGIN_DATA}` — プラグインのデータディレクトリ
- `${user_config.KEY}` — プラグイン有効化時にユーザーが設定した値
- `${VAR}` — システム環境変数

## ライフサイクル管理

### サーバーの状態マシン

```
stopped → starting → running
running → stopping → stopped
any     → error (失敗時)
error   → starting (再試行時)
```

### クラッシュからの復旧

- LSP サーバーがクラッシュした場合は状態を `error` に設定する
- 次のリクエスト時に自動的に再起動を試みる（`ensureServerStarted` 経由）
- `maxRestarts`（デフォルト 3）回を超えると断念する

### 一過性エラーの再試行

- `ContentModified` エラー（LSP エラーコード -32801）は最大 3 回まで自動的に再試行する
- 指数バックオフを使用する: 500ms → 1000ms → 2000ms
- rust-analyzer など、プロジェクトをインデックス中のサーバーでよく発生する

### 診断情報の容量制限

- ファイルごとに最大 10 件の診断
- 全体で最大 30 件の診断
- 超過分は重大度順に並べて切り捨てる（Error > Warning > Info > Hint）
- turn をまたいで重複を排除する。送信済みの同一診断は再送しない
- ファイルの編集後、そのファイルの送信済み記録を消去して新しい診断を通す

### プラグインの再読み込み

プラグインのインストールまたはアンインストール後に `/reload-plugins` を実行すると、`reinitializeLspServerManager()` が呼び出されます。
1. 古いサーバーインスタンスを非同期で終了する
2. 状態を `not-started` にリセットする
3. `initializeLspServerManager()` を呼び出し、プラグイン設定を再読み込みする

## 依存関係

- `vscode-jsonrpc` — JSON-RPC 通信（遅延読み込みされ、実際にサーバーインスタンスを作成するときだけ require される）
- `vscode-languageserver-protocol` — LSP プロトコル型
- `vscode-languageserver-types` — LSP 型定義
- `lru-cache` — 診断の重複排除キャッシュ
