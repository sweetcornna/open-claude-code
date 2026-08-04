<!-- lang-switcher -->
[English](/docs/en/features/mcp-skills) · [中文](/docs/zh/features/mcp-skills) · **日本語**

# MCP_SKILLS — MCP skill の検出

> Feature Flag: `FEATURE_MCP_SKILLS=1`
> 実装状況: 機能として実装済み（config ゲートのフィルタは完成、コア fetcher は stub）
> 参照数: 9

## 1. 機能概要

MCP_SKILLS は、MCP サーバーが公開するリソース（`skill://` URI スキーム）を検出し、呼び出し可能な skill コマンドに変換します。MCP サーバーは tools、prompts、resources を同時に提供できます。この feature を有効にすると、`skill://` URI を持つリソースが skill として認識されます。

### 主な特性

- **自動検出**: MCP サーバーへの接続時に `skill://` リソースを自動取得する
- **コマンド変換**: MCP リソースを `prompt` 型の Command オブジェクトへ変換する
- **リアルタイム更新**: prompts/resources の一覧が変わったときに skill を再取得する
- **キャッシュ整合性**: 接続終了時に skill キャッシュを消去する

## 2. 実装アーキテクチャ

### 2.1 データフロー

```
MCP Server に接続
      │
      ▼
client.ts: connectToServer / setupMcpClientConnections
  ├── fetchToolsForClient     (MCP tools)
  ├── fetchCommandsForClient   (MCP prompts → Command オブジェクト)
  ├── fetchMcpSkillsForClient  (MCP skill:// リソース → Command オブジェクト) [MCP_SKILLS]
  └── fetchResourcesForClient  (MCP resources)
      │
      ▼
commands = [...mcpPrompts, ...mcpSkills]
      │
      ▼
AppState.mcp.commands を更新
      │
      ▼
getMcpSkillCommands() でフィルタ → SkillTool が呼び出す
```

### 2.2 skill のフィルタ

ファイル: `src/commands.ts:604-616`

`getMcpSkillCommands(mcpCommands)` のフィルタ条件:

```ts
cmd.type === 'prompt'                  // prompt 型であること
cmd.loadedFrom === 'mcp'               // MCP サーバー由来であること
!cmd.disableModelInvocation            // モデルから呼び出せること
feature('MCP_SKILLS')                  // feature flag が有効であること
```

### 2.2.1 frontmatter の allowlist（セキュリティ境界）

MCP skill の frontmatter は**リモートサーバー**が制御しますが、ユーザーが許可したのは「この skill を使うこと」だけです。そのため、`loadedFrom === 'mcp'` の skill は、各フィールドが参照される前に `restrictMcpSkillFrontmatter()` で閉じた allowlist に絞り込み、純粋なメタデータだけを残します。

```
name  description  argument-hint  arguments  when_to_use
version  disable-model-invocation  user-invocable
license  compatibility  metadata
```

`allowed-tools`、`hooks`、`shell`、`model`、`context`、`agent`、`effort`、`paths` はすべて削除します。そうしなければ、リモートサーバーは一度の skill 許可を利用して、このターンのツールを事前許可したり、実行可能な shell コマンドを持つ session hook を登録したりできますが、UI はその事実を一度も開示していません。**blocklist ではなく allowlist** を採用しているため、将来追加される権限昇格フィールドも自動的に排除されます。

検出段階にはリソース上限もあります。server ごとに最大 32 skill、1 件あたり 256 KiB、合計 1 MiB、全体で 10 秒のタイムアウトを設け、悪意のあるサーバーが巨大な `resources/list` で接続初期化をブロックしたり、メモリを使い果たしたりするのを防ぎます。

### 2.3 条件付き読み込み

ファイル: `src/services/mcp/client.ts:129-133`

`fetchMcpSkillsForClient` は `require()` で条件付き読み込みされ、feature flag が無効な場合はモジュールを一切読み込みません。

```ts
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? require('../../skills/mcpSkills.js').fetchMcpSkillsForClient
  : null
```

### 2.4 キャッシュ管理

skill 取得関数は `.cache`（Map）を保持し、次のタイミングで消去します。

| イベント | 動作 |
|------|------|
| 接続終了 | 対象 client の skill キャッシュを消去する |
| `disconnectMcpServer()` | skill キャッシュを消去する |
| `prompts/list_changed` 通知 | prompts を更新し、skill を並列取得する |
| `resources/list_changed` 通知 | resources、prompts、skill を更新する |

### 2.5 統合箇所

| ファイル | 行 | 説明 |
|------|------|------|
| `src/commands.ts` | 604-616, 620-633 | コマンドのフィルタと SkillTool コマンドの収集 |
| `src/services/mcp/client.ts` | 129-133, 1394, 1672, 2176 | skill の取得、キャッシュ消去、接続時の取得 |
| `src/services/mcp/useManageMCPConnections.ts` | 22-26, 682-740 | リアルタイム更新（prompts/resources の変更） |

## 3. 重要な設計判断

1. **Feature gate による分離**: `feature('MCP_SKILLS')` が条件付き `require()` とすべての呼び出し箇所を保護する。無効時にはモジュールの読み込みも取得処理も行わない
2. **リソースから skill へのマッピング**: skill は MCP サーバーの `skill://` URI リソースから検出する。`fetchMcpSkillsForClient` が変換を担当する（現在は stub）
3. **循環依存の回避**: `mcpSkillBuilders.ts` を依存グラフのリーフにし、`client.ts ↔ mcpSkills.ts ↔ loadSkillsDir.ts` の循環を避ける
4. **サーバー capability の確認**: skill の取得には、MCP サーバーが resources をサポートすることも必要（`!!client.capabilities?.resources`）

## 4. 使用方法

```bash
# feature を有効化
FEATURE_MCP_SKILLS=1 bun run dev

# 前提条件:
# 1. skill:// リソースをサポートする MCP サーバーを設定済み
# 2. MCP サーバーが resources capability を宣言済み
```

## 5. 実装が必要な箇所

| ファイル | 状況 | 必要な実装 |
|------|------|---------|
| `src/skills/mcpSkills.ts` | Stub | `fetchMcpSkillsForClient()` — MCP リソース一覧から `skill://` URI をフィルタし、Command オブジェクトへ変換する |
| `src/skills/mcpSkillBuilders.ts` | Stub | skill builder の登録（循環依存を避ける） |

## 6. ファイル索引

| ファイル | 責務 |
|------|------|
| `src/commands.ts:547-608` | skill コマンドのフィルタ |
| `src/services/mcp/client.ts:117-2358` | skill の取得とキャッシュ管理 |
| `src/services/mcp/useManageMCPConnections.ts` | リアルタイム更新 |
| `src/skills/mcpSkills.ts` | コア変換ロジック（stub） |
