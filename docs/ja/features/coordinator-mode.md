<!-- lang-switcher -->
[English](/docs/en/features/coordinator-mode) · [中文](/docs/zh/features/coordinator-mode) · **日本語**

# COORDINATOR_MODE — マルチ Agent オーケストレーション

> Feature Flag: `FEATURE_COORDINATOR_MODE=1` + 環境変数 `CLAUDE_CODE_COORDINATOR_MODE=1`
> 実装状況: オーケストレーターは完全に利用可能。worker agent には汎用 AgentTool worker を使用
> 参照数: 32

## 1. 機能概要

COORDINATOR_MODE は CLI を「オーケストレーター」の役割に切り替えます。オーケストレーターはファイルを直接操作せず、AgentTool を介して複数の worker にタスクを割り当て、並列に実行させます。大規模なタスクの分割、並列調査、実装と検証の分離などに適しています。

### 中核となる制約

- オーケストレーターが使用できるのは `Agent`（worker への割り当て）、`SendMessage`（worker の継続）、`TaskStop`（worker の停止）のみ
- Worker はすべての標準ツール（Bash、Read、Edit など）+ MCP ツール + Skill ツールを使用可能
- オーケストレーターの各メッセージはユーザーに表示される。worker の結果は `<task-notification>` XML として届く

## 2. ユーザー操作

### 有効化

```bash
FEATURE_COORDINATOR_MODE=1 CLAUDE_CODE_COORDINATOR_MODE=1 bun run dev
```

feature flag と環境変数の両方を設定する必要があります。`CLAUDE_CODE_COORDINATOR_MODE` はセッションの再開時に自動で切り替えられます（`matchSessionMode`）。

### 典型的なワークフロー

```
ユーザー: 「auth モジュールの null pointer を修正して」

オーケストレーター:
  1. 2 つの worker へ並列に割り当てる:
     - Agent({ description: "auth bug を調査", prompt: "..." })
     - Agent({ description: "auth テストを調査", prompt: "..." })

  2. <task-notification> を受信:
     - Worker A: 「validate.ts:42 で null pointer を発見」
     - Worker B: 「テストのカバレッジは...」

  3. 調査結果を統合し、Worker A を続行:
     - SendMessage({ to: "agent-a1b", message: "validate.ts:42 を修正..." })

  4. 修正結果を受け取り、検証を割り当てる:
     - Agent({ description: "修正を検証", prompt: "..." })
```

## 3. 実装アーキテクチャ

### 3.1 モード検出

ファイル: `src/coordinator/coordinatorMode.ts:36-41`

```ts
export function isCoordinatorMode(): boolean {
  return feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
}
```

### 3.2 セッションモードの復元

`matchSessionMode(sessionMode)` は古いセッションを再開するときに保存済みのモードを確認し、現在の環境変数と保存済みの値が一致しなければ環境変数を自動で反転させます。これにより、通常モードでオーケストレーションセッションを再開すること（およびその逆）を防ぎます。

### 3.3 Worker のツールセット

`getCoordinatorUserContext()` は、worker が使用できるツールの一覧をオーケストレーターへ伝えます。

- **標準モード**: `ASYNC_AGENT_ALLOWED_TOOLS` から内部ツール（TeamCreate、TeamDelete、SendMessage、SyntheticOutput）を除外
- **Simple モード**（`CLAUDE_CODE_SIMPLE=1`）: Bash、Read、Edit のみ
- **MCP ツール**: 接続済み MCP サーバーの名前を列挙
- **Scratchpad**: GrowthBook の `tengu_scratch` が有効な場合、worker 間で共有する scratchpad ディレクトリを提供

### 3.4 システムプロンプト

ファイル: `src/coordinator/coordinatorMode.ts:111-369`

オーケストレーターのシステムプロンプト（`getCoordinatorSystemPrompt()`）は約 370 行で、次の内容を含みます。

| セクション | 内容 |
|------|------|
| 1. Your Role | オーケストレーターの責務の定義 |
| 2. Your Tools | Agent/SendMessage/TaskStop の使用方法 |
| 3. Workers | Worker の能力と制約 |
| 4. Task Workflow | Research → Synthesis → Implementation → Verification のフロー |
| 5. Writing Worker Prompts | 自己完結した prompt の作成指針 + 良い例と悪い例の比較 |
| 6. Example Session | 完全な会話例 |

### 3.5 Worker Agent

ファイル: `src/coordinator/workerAgent.ts`

現在は stub です。Worker は実際には汎用 AgentTool の `worker` subagent_type を使用します。

### 3.6 データフロー

```
ユーザーメッセージ
      │
      ▼
オーケストレーター REPL（制限されたツールセット）
      │
      ├──→ Agent({ subagent_type: "worker", prompt: "..." })
      │         │
      │         ▼
      │    Worker Agent（完全なツールセット）
      │    ├── タスクを実行（Bash/Read/Edit/...）
      │    └── <task-notification> を返す
      │
      ├──→ SendMessage({ to: "agent-id", message: "..." })
      │         │
      │         ▼
      │    既存の Worker を続行
      │
      └──→ TaskStop({ task_id: "agent-id" })
                │
                ▼
           実行中の Worker を停止
```

## 4. 主要な設計判断

1. **二重ゲート設計**: feature flag がコードの利用可能性を制御し、環境変数が実際の有効化を制御する。ビルドには含めつつ、デフォルトでは有効にしない構成が可能
2. **オーケストレーターの制限**: Agent/SendMessage/TaskStop のみを使用可能にし、実行ではなく割り当てに集中させる
3. **Worker にはオーケストレーターの会話が見えない**: 各 worker の prompt は、必要なコンテキストをすべて含む自己完結したものでなければならない
4. **並列性を優先**: システムプロンプトで「Parallelism is your superpower」と強調し、独立したタスクの並列割り当てを促す
5. **転送ではなく統合**: オーケストレーターは worker の発見事項を理解し、具体的な実装指示を作成しなければならない。「based on your findings」のような安易な委任は禁止
6. **Scratchpad による任意の共有**: GrowthBook でゲートされた共有ディレクトリを介して、worker 間で知識を永続化して共有できる

## 5. 使用方法

```bash
# 基本的な有効化
FEATURE_COORDINATOR_MODE=1 CLAUDE_CODE_COORDINATOR_MODE=1 bun run dev

# Fork Subagent と併用
FEATURE_COORDINATOR_MODE=1 FEATURE_FORK_SUBAGENT=1 \
CLAUDE_CODE_COORDINATOR_MODE=1 bun run dev

# Simple モード（worker は Bash/Read/Edit のみ）
FEATURE_COORDINATOR_MODE=1 CLAUDE_CODE_COORDINATOR_MODE=1 \
CLAUDE_CODE_SIMPLE=1 bun run dev
```

## 6. ファイル索引

| ファイル | 行数 | 責務 |
|------|------|------|
| `src/coordinator/coordinatorMode.ts` | 370 | モード検出 + システムプロンプト + ユーザーコンテキスト |
| `src/coordinator/workerAgent.ts` | — | Worker agent の定義（stub） |
| `src/constants/tools.ts` | — | `ASYNC_AGENT_ALLOWED_TOOLS` ツール許可リスト |
