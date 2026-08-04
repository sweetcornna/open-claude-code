<!-- lang-switcher -->
[English](/docs/en/features/token-budget) · [中文](/docs/zh/features/token-budget) · **日本語**

# TOKEN_BUDGET — トークン予算による自動継続モード

> Feature Flag: `FEATURE_TOKEN_BUDGET=1`
> 実装状況: 完全に利用可能

## 1. 機能概要

TOKEN_BUDGET を使うと、ユーザーはプロンプト内で output token の予算目標（`+500k`、`spend 2M tokens` など）を指定できます。Claude は目標に達するまで**自動的に作業を継続**するため、ユーザーが何度も Enter を押して続きを促す必要はありません。

大規模なリファクタリング、一括変更、大量のコード生成など、複数ラウンドのツール呼び出しを必要とする長時間タスクに適しています。

## 2. ユーザー操作

### 構文

| 形式 | 例 | 説明 |
|------|------|------|
| 省略形（先頭） | `+500k` | 入力の先頭に直接記述 |
| 省略形（末尾） | `このモジュールをリファクタリングして +2m` | 入力の末尾に追加 |
| 完全な構文 | `spend 2M tokens` または `use 1B tokens` | 自然言語の文中に埋め込む |

単位は `k`（千）、`m`（百万）、`b`（十億）に対応し、大文字と小文字は区別しません。

### UI のフィードバック

- **入力欄の強調表示**: 入力に予算構文が含まれると、該当テキストが強調表示されます（`PromptInput.tsx` が `findTokenBudgetPositions` で位置を計算）。
- **スピナーの進捗**: 画面下部のスピナーが次の形式でリアルタイムの進捗を表示します。
  - 未完了: `Target: 125,000 / 500,000 (25%) · ~2m 30s`
  - 完了: `Target: 510,000 used (500,000 min ✓)`
  - 現在の token 生成速度から算出した ETA を含む

## 3. 実装アーキテクチャ

### データフロー

```
ユーザー入力 "+500k"
     │
     ▼
┌─────────────────────────┐
│  parseTokenBudget()     │  src/utils/tokenBudget.ts
│  正規表現で解析 → 500,000 │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  REPL.tsx               │  送信時に呼び出す
│  snapshotOutputTokens   │  snapshotOutputTokensForTurn(500000)
│  ForTurn(500000)        │  turn 開始時の token 数と予算を記録
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  query.ts のメインループ │  各ラウンド終了後に確認
│  checkTokenBudget()     │  現在の output tokens と予算を比較
└────────┬────────────────┘
         │
    ┌────┴─────┐
    │          │
    ▼          ▼
 continue    stop
 (90% 未満)  (90% 到達または収穫逓減)
    │          │
    ▼          ▼
 nudge を注入  通常終了
 メッセージを継続  完了イベントを送信
```

### 中核モジュール

#### 1. 解析層 — `src/utils/tokenBudget.ts`

3 つの正規表現でユーザー入力を解析します。

```
SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i   // "+500k" が先頭
SHORTHAND_END_RE   = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i  // "+2m" が末尾
VERBOSE_RE         = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i  // "spend 2M tokens"
```

- `parseTokenBudget(text)` — 予算値を抽出し、`number | null` を返す
- `findTokenBudgetPositions(text)` — 入力欄での強調表示に使う一致位置の配列を返す
- `getBudgetContinuationMessage(pct, turnTokens, budget)` — 継続メッセージを生成する

#### 2. 状態層 — `src/bootstrap/state.ts`

モジュールレベルのシングルトン変数で現在の turn の予算状態を追跡します。

```
outputTokensAtTurnStart   — この turn の開始時点における累積 output token 数
currentTurnTokenBudget    — この turn の予算目標（null は予算なし）
budgetContinuationCount   — この turn で自動継続した回数
```

主要な関数:
- `getTotalOutputTokens()` — `STATE.modelUsage` から全モデルの output tokens を集計する
- `getTurnOutputTokens()` — `getTotalOutputTokens() - outputTokensAtTurnStart`
- `snapshotOutputTokensForTurn(budget)` — turn の起点をリセットし、新しい予算を設定する
- `getCurrentTurnTokenBudget()` — 現在の予算を返す

#### 3. 判断層 — `src/query/tokenBudget.ts`

`checkTokenBudget(tracker, agentId, budget, globalTurnTokens)` が continue/stop を判断します。

**継続条件**:
- サブエージェント内ではない（`agentId` が空）
- 予算が存在し、かつ > 0
- 現在の token が予算の **90%** に達していない
- 収穫逓減ではない（nudge が 3 ラウンド連続した後、各ラウンドの増分が < 500 tokens ではない）

**停止条件**:
- 予算の 90% に到達した
- 収穫逓減に達した（モデルがこれ以上実質的に作業できない）
- サブエージェントモードではそのままスキップする

**収穫逓減の検出**: `continuationCount >= 3` かつ直近 2 回の nudge の delta がいずれも < 500 tokens。

#### 4. メインループへの統合 — `src/query.ts`

```
query() 関数内:
  1. budgetTracker = createBudgetTracker() を作成
  2. while ループに入る
  3. 各ラウンド終了後に checkTokenBudget() を呼び出す
  4. decision.action === 'continue' の場合:
     - meta user message（nudge）を注入
     - continue でループ先頭へ戻る
  5. decision.action === 'stop' の場合:
     - 完了イベントを記録（diminishingReturns フラグを含む）
     - 通常どおり return
```

#### 5. UI 層

| ファイル | 責務 |
|------|------|
| `components/PromptInput/PromptInput.tsx:534` | 入力欄で予算構文を強調表示する |
| `components/Spinner.tsx:319-338` | スピナーに進捗率と ETA を表示する |
| `screens/REPL.tsx:2897` | 送信時に予算を解析してスナップショットを取る |
| `screens/REPL.tsx:2138` | ユーザーがキャンセルしたときに予算をクリアする |
| `screens/REPL.tsx:2963` | turn 終了時に表示用の予算情報を取得する |

#### 6. システムプロンプト — `src/constants/prompts.ts:538-551`

`token_budget` section を注入します。

> "When the user specifies a token target (e.g., '+500k', 'spend 2M tokens', 'use 1B tokens'), your output token count will be shown each turn. Keep working until you approach the target — plan your work to fill it productively. The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you."

この prompt は予算の有効・無効にかかわらず**無条件でキャッシュ**されます。予算が指定されていない場合、"When the user specifies..." という表現は何もしないためです。

#### 7. API 添付情報 — `src/utils/attachments.ts:3830-3845`

各ラウンドの API 呼び出しに `output_token_usage` attachment を付加します。

```json
{
  "type": "output_token_usage",
  "turn": 125000,     // この turn の生成量
  "session": 350000,  // セッション全体の生成量
  "budget": 500000    // 予算目標
}
```

これにより、モデル自身が進捗を確認できます。

## 4. 主要な設計判断

1. **100% ではなく 90% のしきい値**: `COMPLETION_THRESHOLD = 0.9` で停止し、最後の nudge によって生成される token が予算を大幅に超えることを防ぐ
2. **収穫逓減への保護**: nudge が 3 ラウンド連続した後、各ラウンドの生成量が < 500 tokens なら、モデルに実質的な進捗がないと判断して早期終了する
3. **サブエージェントの除外**: AgentTool 内部のサブタスクでは予算を確認せず、サブタスクが重複して継続を起動することを防ぐ
4. **システムプロンプトの無条件キャッシュ**: 予算 prompt は常に注入し、予算の変更に応じて toggle しない。予算を切り替えるたびに約 20K token の cache miss が発生することを防ぐため
5. **ユーザーのキャンセル時に予算をクリア**: Escape でキャンセルすると `snapshotOutputTokensForTurn(null)` を呼び出し、残った予算による継続の起動を防ぐ

## 5. 使用方法

```bash
# feature を有効化
FEATURE_TOKEN_BUDGET=1 bun run dev

# prompt で使用
> +500k すべてのテストファイルをリファクタリングして
> spend 2M tokens このプロジェクトを JS から TS へ移行して
> 完全な CRUD モジュールを書いて +1m
```

## 6. ファイル索引

| ファイル | 行数 | 責務 |
|------|------|------|
| `src/utils/tokenBudget.ts` | 73 | 正規表現による解析 + 位置検索 + 継続メッセージの生成 |
| `src/query/tokenBudget.ts` | 93 | 予算トラッカー + continue/stop の判断 |
| `src/bootstrap/state.ts:724-743` | 20 | turn 単位の token スナップショット状態 |
| `src/constants/prompts.ts:538-551` | 14 | システムプロンプトの注入 |
| `src/utils/attachments.ts:3830-3844` | 17 | API attachment の付加 |
| `src/query.ts:280,1311-1358` | 48 | メインループへの統合 |
| `src/screens/REPL.tsx:2897,2963,2138` | 20 | REPL の送信/完了/キャンセル処理 |
| `src/components/Spinner.tsx:319-338` | 20 | 進捗バー UI |
| `src/components/PromptInput/PromptInput.tsx:534` | 1 | 入力の強調表示 |
