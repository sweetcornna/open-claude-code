<!-- lang-switcher -->
[English](/docs/en/features/ultraplan) · [中文](/docs/zh/features/ultraplan) · **日本語**

# ULTRAPLAN — 強化された計画

> Feature Flag: `FEATURE_ULTRAPLAN=1`
> 実装状況：キーワード検出、コマンド処理、CCR リモートセッションはすべて完成
> 参照数：10

## 1. 機能概要

ULTRAPLAN はユーザー入力から "ultraplan" キーワードを検出すると、自動的に強化計画モードへ入ります。通常の plan mode よりも詳細な計画機能を提供し、ローカル実行とリモート（CCR）実行に対応します。

### 起動方法

| 方法 | 動作 |
|------|------|
| "ultraplan" を含むテキストを入力 | 自動的に `/ultraplan` コマンドへリダイレクト |
| `/ultraplan` スラッシュコマンド | 直接実行 |
| レインボー強調表示 | 入力欄の "ultraplan" キーワードをレインボーアニメーションで表示 |

## 2. 実装アーキテクチャ

### 2.1 モジュールの状態

| モジュール | ファイル | 行数 | 状態 |
|------|------|------|------|
| コマンドハンドラー | `src/commands/ultraplan.tsx` | 525 | **完成** |
| CCR セッション | `src/utils/ultraplan/ccrSession.ts` | 349 | **完成** |
| キーワード検出 | `src/utils/ultraplan/keyword.ts` | 127 | **完成** |
| 埋め込みプロンプト | `src/utils/ultraplan/prompt.txt` | 1 | **完成** |
| REPL ダイアログ | `src/screens/REPL.tsx` | — | **配線済み** |
| キーワード強調表示 | `src/components/PromptInput/PromptInput.tsx` | — | **配線済み** |

### 2.2 キーワード検出

ファイル：`src/utils/ultraplan/keyword.ts`（127 行）

`findUltraplanTriggerPositions(text)` は次の項目を適切に除外します。
- 引用符内の "ultraplan" を除外
- パス内の "ultraplan" を除外（例：`/path/to/ultraplan/`）
- スラッシュコマンド以外のコンテキストを除外
- `replaceUltraplanKeyword(text)` でキーワードを取り除く

### 2.3 CCR リモートセッション

ファイル：`src/utils/ultraplan/ccrSession.ts`（349 行）

`ExitPlanModeScanner` クラスは完全なイベントステートマシンを実装します。
- `pollForApprovedExitPlanMode()` — ポーリング間隔は 3 秒
- タイムアウト処理と再試行
- リモート（teleport）実行とローカル実行に対応

### 2.4 データフロー

```
ユーザー入力「このモジュールのリファクタリングを ultraplan して」
         │
         ▼
processUserInput が "ultraplan" を検出
         │
         ▼
/ultraplan コマンドへリダイレクト
         │
         ├── ローカル実行 → EnterPlanMode
         │
         └── リモート実行 → teleportToRemote → CCR セッション
                │
                ▼
         ExitPlanModeScanner がポーリング
                │
                ▼
         ユーザーがリモートで承認 → ローカルで結果を受信
```

## 3. 補完が必要な内容

| モジュール | 説明 |
|------|------|
| `src/screens/REPL.tsx` の UltraplanChoiceDialog / UltraplanLaunchDialog | ローカル実行かリモート実行かをユーザーが選ぶためのダイアログコンポーネント |
| `src/commands/ultraplan/` | 空のディレクトリ。未マージのサブコマンド構造である可能性がある |

## 4. 重要な設計判断

1. **適切なキーワードフィルター**：引用符内やパス内の "ultraplan" を除外し、誤起動を防ぎます
2. **ローカルとリモートの 2 モード**：ローカルの plan mode と CCR リモートセッションに対応します
3. **レインボー強調表示によるフィードバック**：入力欄の "ultraplan" キーワードにレインボーアニメーションを使い、特殊な機能であることを示します
4. **processUserInput との統合**：ユーザー入力の処理パイプラインで捕捉し、シームレスにリダイレクトします

## 5. 使用方法

```bash
# feature を有効化
FEATURE_ULTRAPLAN=1 bun run dev

# REPL で使用
# > ultraplan 認証モジュールをリファクタリング
# > /ultraplan
```

## 6. ファイル索引

| ファイル | 行数 | 責務 |
|------|------|------|
| `src/commands/ultraplan.tsx` | 525 | スラッシュコマンドハンドラー |
| `src/utils/ultraplan/ccrSession.ts` | 349 | CCR リモートセッション管理 |
| `src/utils/ultraplan/keyword.ts` | 127 | キーワードの検出と置換 |
| `src/utils/ultraplan/prompt.txt` | 1 | 埋め込みプロンプト |
| `src/utils/processUserInput/processUserInput.ts:468` | — | キーワードのリダイレクト |
| `src/components/PromptInput/PromptInput.tsx` | — | レインボー強調表示 |
