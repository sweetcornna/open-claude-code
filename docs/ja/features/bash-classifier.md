<!-- lang-switcher -->
[English](/docs/en/features/bash-classifier) · [中文](/docs/zh/features/bash-classifier) · **日本語**

# BASH_CLASSIFIER — Bash コマンド分類器

> Feature Flag: `FEATURE_BASH_CLASSIFIER=1`
> 実装状況: bashClassifier.ts はすべて stub。yoloClassifier.ts の完全な実装を参照可能
> 参照数: 45

## 1. 機能概要

BASH_CLASSIFIER は LLM を使って bash コマンドの意図を分類し（許可/拒否/確認）、権限判断を自動化します。ユーザーが bash コマンドを一つずつ承認する必要はなく、分類器がコマンドの内容とコンテキストから安全性を自動判断します。

### 主な特性

- **LLM による分類**: Opus モデルでコマンドの安全性を評価する
- **2 段階分類**: 高速なブロック/許可 → 詳細な chain-of-thought
- **自動承認**: 分類器が安全と判断したコマンドを自動的に通す
- **UI 統合**: 権限ダイアログに分類器の状態とレビューオプションを表示する

## 2. 実装アーキテクチャ

### 2.1 モジュールの状況

| モジュール | ファイル | 状況 | 説明 |
|------|------|------|------|
| Bash 分類器 | `src/utils/permissions/bashClassifier.ts` | **Stub** | すべての関数が no-op を返す。コメント: "ANT-ONLY" |
| YOLO 分類器 | `src/utils/permissions/yoloClassifier.ts` | **完成** | 1496 行、2 段階の XML 分類器 |
| 承認シグナル | `src/utils/classifierApprovals.ts` | **完成** | Map + シグナルで分類器の判断を管理する |
| 権限 UI | `src/components/permissions/BashPermissionRequest.tsx` | **接続済み** | 分類器の状態表示とレビューオプション |
| 権限パイプライン | `src/hooks/toolPermission/handlers/*.ts` | **接続済み** | 分類器の結果を判断へルーティングする |
| API beta ヘッダー | `src/services/api/withRetry.ts` | **接続済み** | 有効時に `bash_classifier` beta を送信する |

### 2.2 参照実装: yoloClassifier.ts

ファイル: `src/utils/permissions/yoloClassifier.ts`（1496 行）

これは実装済みの完全な分類器で、bashClassifier.ts の参照実装として利用できます。

```
2 段階分類:
1. 高速段階: 会話履歴を構築 → sideQuery（Opus）を呼び出す → 高速にブロック/許可
2. 詳細段階: chain-of-thought で分析 → 最終判断
```

特性:
- 完全な会話履歴コンテキストを構築する
- 安全性を扱う system prompt で sideQuery を呼び出す
- GrowthBook の設定とメトリクス
- エラー処理とフォールバック

### 2.3 権限パイプラインにおける分類器の位置

```
bash コマンドが到着
      │
      ▼
bashPermissions.ts 権限チェック
      │
      ├── 従来の規則照合（文字列レベル）
      │
      └── [BASH_CLASSIFIER] LLM 分類
            │
            ├── allow → 自動許可
            ├── deny → 自動拒否
            └── ask → 権限ダイアログを表示
                  │
                  ├── 分類器による自動承認の印
                  └── レビューオプション（ユーザーが上書き可能）
```

## 3. 実装が必要な箇所

| 関数 | 必要な実装 | 説明 |
|------|---------|------|
| `classifyBashCommand()` | LLM 呼び出しによる安全性評価 | yoloClassifier.ts の 2 段階方式を参照する |
| `isClassifierPermissionsEnabled()` | GrowthBook/設定チェック | 分類器を有効にするか制御する |
| `getBashPromptDenyDescriptions()` | prompt ベースの拒否規則を返す | 権限設定の説明 |
| `getBashPromptAskDescriptions()` | 確認規則を返す | ユーザーの確認が必要なコマンド |
| `getBashPromptAllowDescriptions()` | 許可規則を返す | 自動的に通すコマンド |
| `generateGenericDescription()` | LLM によるコマンド説明の生成 | 権限ダイアログに説明を提供する |
| `extractPromptDescription()` | 規則の内容を解析する | 規則から説明を抽出する |

## 4. 重要な設計判断

1. **ANT-ONLY の印**: bashClassifier.ts には "ANT-ONLY" と記載されており、Anthropic 内部のサーバー側分類器に対するクライアントアダプターである可能性がある
2. **2 段階分類**: 高速段階で明確なケースを処理してレイテンシを減らし、詳細段階で曖昧なケースを処理する
3. **分類器の結果をレビュー可能**: 権限 UI に分類器の判断を表示し、ユーザーが上書きできる
4. **YOLO 分類器を参照**: yoloClassifier.ts は完全な分類器の実装パターンを提供し、そのまま参照できる

## 5. 使用方法

```bash
# feature を有効化
FEATURE_BASH_CLASSIFIER=1 bun run dev

# TREE_SITTER_BASH と併用（AST + LLM による二重の安全性検査）
FEATURE_BASH_CLASSIFIER=1 FEATURE_TREE_SITTER_BASH=1 bun run dev
```

## 6. ファイル索引

| ファイル | 行数 | 責務 |
|------|------|------|
| `src/utils/permissions/bashClassifier.ts` | — | Bash 分類器（stub、ANT-ONLY） |
| `src/utils/permissions/yoloClassifier.ts` | 1496 | YOLO 分類器（完全な参照実装） |
| `src/utils/classifierApprovals.ts` | — | 分類器の承認シグナル管理 |
| `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx` | — | 分類器 UI |
| `src/hooks/toolPermission/handlers/interactiveHandler.ts` | — | 対話型の権限処理 |
| `src/services/api/withRetry.ts` | — | API beta ヘッダー |
