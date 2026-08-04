<!-- lang-switcher -->
[English](/docs/en/features/fork-subagent) · [中文](/docs/zh/features/fork-subagent) · **日本語**

# FORK_SUBAGENT — コンテキストを継承するサブ Agent

> Feature Flag: `FEATURE_FORK_SUBAGENT=1`
> 実装状況: 完全に利用可能
> 参照数: 4

## 1. 機能概要

FORK_SUBAGENT は、AgentTool に親の完全な会話コンテキストを継承する「fork サブ agent」を生成させます。サブ agent は親のすべての履歴メッセージ、ツールセット、システムプロンプトを参照でき、さらに親と API リクエストの接頭辞を共有して prompt cache のヒット率を最大化します。

### 主な利点

- **Prompt Cache の最大化**: 複数の並列 fork は同一の API リクエスト接頭辞を共有し、最後の directive テキストブロックだけが異なる
- **コンテキストの完全性**: サブ agent は親の完全な会話履歴（thinking config を含む）を継承する
- **権限のバブルアップ**: サブ agent の権限プロンプトを親のターミナルに表示する
- **Worktree の分離**: git worktree による分離をサポートし、サブ agent は独立したブランチで作業する

## 2. ユーザー操作

### 起動方法

`FORK_SUBAGENT` が有効な場合、AgentTool の呼び出しで `subagent_type` を指定しなければ、自動的に fork 経路へ進みます。

```
// Fork 経路（コンテキストを継承）
Agent({ prompt: "この bug を修正" })  // subagent_type なし

// 通常の agent 経路（新しいコンテキスト）
Agent({ subagent_type: "general-purpose", prompt: "..." })
```

### `/fork` コマンドについて

このリポジトリには `/fork` スラッシュコマンドは**ありません**。fork 経路を起動できるのは、`subagent_type` を指定しない AgentTool 呼び出しだけです。現在の `fork` は `/branch`（セッション分岐）コマンドの無条件の別名です。`src/commands/branch/index.ts:6` の `aliases: ['fork']` を参照してください。これは `FORK_SUBAGENT` ゲートの影響を受けません。

## 3. 実装アーキテクチャ

### 3.1 ゲートと排他制御

ファイル: `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts:32-39`

```ts
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false   // Coordinator は独自の委任モデルを持つ
    if (getIsNonInteractiveSession()) return false  // pipe/SDK モードでは無効
    return true
  }
  return false
}
```

### 3.2 FORK_AGENT の定義

```ts
export const FORK_AGENT = {
  agentType: 'fork',
  tools: ['*'],              // ワイルドカード: 親の完全なツールセットを使用
  maxTurns: 200,
  model: 'inherit',          // 親のモデルを継承
  permissionMode: 'bubble',  // 権限を親のターミナルへバブルアップ
  getSystemPrompt: () => '', // 未使用: 親で描画済みの prompt を直接渡す
}
```

### 3.3 中核となる呼び出しフロー

```
AgentTool.call({ prompt, name })
      │
      ▼
isForkSubagentEnabled() && !subagent_type?
      │
      ├── No → 通常の agent 経路
      │
      └── Yes → Fork 経路
            │
            ▼
      再帰防止チェック
      ├── querySource === 'agent:builtin:fork' → 拒否
      └── isInForkChild(messages) → 拒否
            │
            ▼
      親の system prompt を取得
      ├── toolUseContext.renderedSystemPrompt（優先）
      └── buildEffectiveSystemPrompt（フォールバック）
            │
            ▼
      buildForkedMessages(prompt, assistantMessage)
      ├── 親の assistant メッセージを複製
      ├── プレースホルダー tool_result を生成
      └── directive テキストブロックを追加
            │
            ▼
      [任意] buildWorktreeNotice()
            │
            ▼
      runAgent({
        useExactTools: true,
        override.systemPrompt: 親,
        forkContextMessages: 親のメッセージ,
        availableTools: 親のツール,
      })
```

### 3.4 メッセージの構築: buildForkedMessages

ファイル: `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts:107-169`

構築されるメッセージの構造:

```
[
  ...history (filterIncompleteToolCalls),  // 親の完全な履歴
  assistant(すべての tool_use ブロック),  // 親の現在の turn の assistant メッセージ
  user(
    プレースホルダー tool_result × N +    // 同一のプレースホルダーテキスト
    <fork-boilerplate> directive           // fork ごとに異なる
  )
]
```

**すべての fork が同じプレースホルダーテキストを使用します**: `"Fork started — processing in background"`。これにより、複数の並列 fork で API リクエストの接頭辞が完全に一致し、prompt cache のヒットを最大化できます。

### 3.5 再帰防止

2 段階のチェックで fork のネストを防ぎます。

1. **querySource チェック**: `toolUseContext.options.querySource === 'agent:builtin:fork'`。`context.options` に設定されるため、自動圧縮に耐えられる（autocompact はメッセージだけを書き換え、options は変更しない）
2. **メッセージの走査**: `isInForkChild()` がメッセージ履歴内の `<fork-boilerplate>` タグを走査する

### 3.6 Worktree 分離の通知

fork と worktree を組み合わせる場合は、次の通知を追加してサブ agent へ伝えます。

> 「親 agent が `{parentCwd}` で行った会話コンテキストを継承しましたが、あなたは独立した git worktree `{worktreeCwd}` で操作します。パスを変換し、編集前に再度読み取ってください。」

### 3.7 非同期の強制

`isForkSubagentEnabled()` が true の場合、すべての agent の起動を強制的に非同期にします。`run_in_background` 引数は schema から削除されます。やり取りはすべて `<task-notification>` XML メッセージを介して行います。

## 4. Prompt Cache の最適化

これが fork 設計全体の中核となる最適化目標です。

| 最適化項目 | 実装 |
|--------|------|
| **同一の system prompt** | `renderedSystemPrompt` を直接渡し、再描画を避ける（GrowthBook の状態が一致しない可能性があるため） |
| **同一のツールセット** | `useExactTools: true` で親のツールを直接使用し、`resolveAgentTools` のフィルタリングを通さない |
| **同一の thinking config** | 親の thinking 設定を継承する（fork 以外の agent では thinking がデフォルトで無効） |
| **同一のプレースホルダー結果** | すべての fork が同じ `FORK_PLACEHOLDER_RESULT` テキストを使用 |
| **ContentReplacementState の複製** | デフォルトで親の置換状態を複製し、wire prefix の一致を維持 |

## 5. サブ Agent への指示

`buildChildMessage()` は `<fork-boilerplate>` で囲まれた指示を生成します。

- 自分は fork worker であり、メインの agent ではない
- サブ agent を再び spawn してはならない（直接実行する）
- 雑談やメタコメントをしない
- ツールを直接使用する
- ファイルを変更したら commit し、commit hash を報告する
- 報告形式: `Scope:` / `Result:` / `Key files:` / `Files changed:` / `Issues:`

## 6. 主要な設計判断

1. **Fork ≠ 通常の agent**: fork は完全なコンテキストを継承するが、通常の agent はゼロから開始する。選択基準は `subagent_type` が存在するかどうか
2. **renderedSystemPrompt の直接受け渡し**: fork 時に `getSystemPrompt()` を再度呼び出すことを避ける。親は turn の開始時に prompt のバイト列を固定する
3. **プレースホルダー結果の共有**: 複数の並列 fork は完全に同じプレースホルダーを使用し、directive だけが異なる
4. **Coordinator との排他制御**: Coordinator モードでは fork を無効にする。両者の委任モデルには互換性がない
5. **非対話モードでは無効**: pipe モードと SDK モードでは無効にし、見えない fork のネストを避ける

## 7. 使用方法

```bash
# feature を有効化
FEATURE_FORK_SUBAGENT=1 bun run dev

# REPL で使用（subagent_type を指定しなければ fork 経路へ進む）
# Agent({ prompt: "このモジュールの構造を調査" })
# Agent({ prompt: "この機能を実装" })
```

## 8. ファイル索引

| ファイル | 行数 | 責務 |
|------|------|------|
| `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts` | ~210 | 中核定義 + メッセージ構築 + 再帰防止 |
| `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` | — | Fork ルーティング + 非同期の強制 |
| `packages/builtin-tools/src/tools/AgentTool/prompt.ts` | — | 「When to Fork」プロンプトのセクション |
| `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` | — | useExactTools 経路 |
| `packages/builtin-tools/src/tools/AgentTool/resumeAgent.ts` | — | Fork agent の再開 |
| `src/constants/xml.ts` | — | XML タグの定数 |
| `src/utils/forkedAgent.ts` | — | CacheSafeParams + ContentReplacementState の複製 |
