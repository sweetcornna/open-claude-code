<!-- lang-switcher -->
[English](/docs/en/features/auto-dream) · [中文](/docs/zh/features/auto-dream) · **日本語**

# Auto Dream — メモリの自動整理

## 概要

Auto Dream は Claude Code のバックグラウンドメモリ統合機構です。セッション間で永続メモリファイルを自動的にレビュー、整理、刈り込みし、将来のセッションが正確なコンテキストをすばやく取得できる状態を保ちます。

メモリシステムはファイルシステム上（デフォルトは `~/.occ/projects/<project-slug>/memory/`）に保存され、索引ファイル `MEMORY.md` と複数のトピックファイル（`user_language.md`、`project_overview.md` など）で構成されます。セッションが蓄積するにつれ、メモリは古くなったり、冗長になったり、矛盾したりします。Dream はこの蓄積を整理します。

## アーキテクチャ

### 中核モジュール

| モジュール | パス | 責務 |
|------|------|------|
| スケジューラ | `src/services/autoDream/autoDream.ts` | 時間/セッション/ロックの 3 段階ゲートで forked agent を起動する |
| 設定 | `src/services/autoDream/config.ts` | `isAutoDreamEnabled()` スイッチを読み取る |
| プロンプト | `src/services/autoDream/consolidationPrompt.ts` | 4 フェーズの整理プロンプトを構築する |
| ロックファイル | `src/services/autoDream/consolidationLock.ts` | PID ロック + mtime を `lastConsolidatedAt` として使用する |
| タスク UI | `src/tasks/DreamTask/DreamTask.ts` | バックグラウンドタスクを登録し、footer pill + Shift+Down で表示可能にする |
| 手動エントリ | `src/skills/bundled/dream.ts` | `/dream` コマンド。常に利用可能 |

### メモリパスの解決

優先順位（`src/memdir/paths.ts`）:

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 環境変数（完全なパスで上書き）
2. `autoMemoryDirectory` 設定（`settings.json`、`~/` の展開に対応）
3. デフォルト: `<memoryBase>/projects/<sanitized-git-root>/memory/`

ここで `memoryBase` = `CLAUDE_CODE_REMOTE_MEMORY_DIR` または `~/.occ` です。

## 起動条件

### 自動起動（Auto Dream）

各対話 turn の終了後、`executeAutoDream()` は 3 段階のゲートを順番に確認します。

```
┌─────────────────────────────────────────────────────┐
│  Gate 1: グローバルスイッチ                          │
│  isAutoMemoryEnabled() && isAutoDreamEnabled()       │
│  除外: KAIROS モード / Remote モード                  │
├─────────────────────────────────────────────────────┤
│  Gate 2: 時間 gate                                   │
│  hoursSince(lastConsolidatedAt) >= minHours          │
│  デフォルト: 24 時間                                  │
├─────────────────────────────────────────────────────┤
│  Gate 3: セッション gate                              │
│  sessionsTouchedSince(lastConsolidatedAt) >= minSessions │
│  デフォルト: 5 セッション（現在のセッションを除く）     │
├─────────────────────────────────────────────────────┤
│  Lock: PID lock file                                 │
│  .consolidate-lock (mtime = lastConsolidatedAt)      │
│  終了済みプロセスの検出 + 1 時間で期限切れ             │
└─────────────────────────────────────────────────────┘
```

すべてのゲートを通過すると、**forked agent**（制限付きサブエージェント）として整理タスクを実行します。

- Bash ツールは読み取り専用コマンド（`ls`、`grep`、`cat` など）に制限される
- 読み書きできるのはメモリディレクトリ内のファイルだけ
- ユーザーは Shift+Down のバックグラウンドタスクパネルで進捗を確認し、終了させることができる

### 手動起動（`/dream` コマンド）

`/dream` コマンドを使えば、ゲートの制限なしでいつでも起動できます。

- メインループ内で実行する（forked agent ではない）ため、すべてのツール権限を持つ
- ユーザーは処理をリアルタイムで確認できる
- 実行前にロックファイルの mtime を自動更新する

### 設定スイッチ

| スイッチ | 場所 | 作用 |
|------|------|------|
| `autoDreamEnabled` | `settings.json` | `true`/`false` の明示的なスイッチ |
| `autoMemoryEnabled` | `settings.json` | 全体スイッチ。無効にするとすべてのメモリ機能が無効になる |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 環境変数 | `1`/`true` ですべてのメモリ機能を無効にする |
| `tengu_onyx_plover` | GrowthBook | 公式のリモート設定。`enabled`/`minHours`/`minSessions` を制御する |

デフォルト値（GrowthBook に接続していない場合）:

```typescript
minHours: 24      // 前回の整理から 24 時間以上
minSessions: 5    // 新しいセッションが 5 件以上
```

## 整理フロー（4 フェーズ）

Dream agent が実行するプロンプトは 4 つのフェーズで構成されます。

### Phase 1 — 状況把握（Orient）

- メモリディレクトリを `ls` して既存ファイルを確認する
- 索引 `MEMORY.md` を読み取る
- 既存のトピックファイルを確認し、重複したファイルの作成を避ける

### Phase 2 — シグナル収集（Gather）

優先順位に従って新しい情報を収集します。

1. **ログファイル**（`logs/YYYY/MM/YYYY-MM-DD.md`、KAIROS モードの追記専用ログ）
2. **古くなったメモリ** — 現在のコードベースの状態と矛盾する事実
3. **セッション記録** — 絞り込んだキーワードで JSONL ファイルを grep する（全文は読み取らない）

### Phase 3 — 統合（Consolidate）

- 似たファイルを新規作成せず、新しいシグナルを既存のトピックファイルへ統合する
- 相対日付（「昨日」「先週」）を絶対日付へ変換する
- 否定された事実を削除する

### Phase 4 — 刈り込みと索引（Prune）

- `MEMORY.md` を 200 行以内、25KB 以内に保つ
- 各索引項目を 1 行、150 文字以内にする
- 古い、誤った、または置き換えられたポインタを削除する

## メモリの種類

メモリシステムは 4 種類の型（`src/memdir/memoryTypes.ts`）を使用します。

| 型 | 用途 | 例 |
|------|------|------|
| `user` | ユーザーの役割、好み、知識 | ユーザーはシニアバックエンドエンジニアで、中国語でのやり取りを好む |
| `feedback` | 作業方法の指針 | データベーステストを mock しない。コードレビューには bundled PR を使う |
| `project` | プロジェクトのコンテキスト（コードから推論できないもの） | マージ凍結は 3 月 5 日から。認証の書き直しはコンプライアンス要件 |
| `reference` | 外部システムへのポインタ | Linear の INGEST プロジェクトでパイプラインのバグを追跡する |

**保存しない情報**: コードパターン、アーキテクチャ、ファイルパス（コードから推論可能）。Git 履歴（`git log` が信頼できる真源）。デバッグ手順（コード内に存在）。

## ロックファイルの仕組み

`.consolidate-lock` ファイルはメモリディレクトリ内にあります。

- **ファイル内容**: 所有者の PID
- **mtime**: `lastConsolidatedAt` のタイムスタンプ
- **有効期限**: 1 時間（PID の再利用に備える）
- **競合処理**: 2 つのプロセスが同時に書き込んだ場合、後から読み取って PID を検証し、失敗した側が終了する
- **ロールバック**: forked agent が失敗するかユーザーに終了された場合、mtime をロック取得前の値に戻す

## ユースケース

### ユースケース 1: 日常開発での自動整理

開発者が数日間にわたり Claude Code で異なるタスクを処理します。5 件以上のセッションが蓄積し、前回の整理から 24 時間経過すると Auto Dream が自動的に起動し、複数のセッションに散らばったユーザーの好みとプロジェクト上の判断を統合します。

### ユースケース 2: メモリの手動整理

Claude が同じ誤りを繰り返す、または以前の判断を忘れていることにユーザーが気付いた場合、`/dream` を入力してすぐに整理を起動できます。自動起動の周期を待つ必要はありません。

### ユースケース 3: 新しいセッションでの迅速なコンテキスト取得

新しいセッションの開始時に、`MEMORY.md` がコンテキストへ読み込まれます。Dream によって整理されたメモリファイルは構造が明確で情報も正確なため、Claude はユーザーとプロジェクトをすばやく把握できます。

### ユースケース 4: KAIROS モードでのログ蒸留

KAIROS（常駐アシスタントモード）では、agent が日付別のログファイルへ追記専用で書き込みます。Dream はこれらのログをトピックファイルと `MEMORY.md` の索引へ蒸留します。

## ほかのシステムとの関係

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│ セッション対話 │────▶│ メモリ書き込み │────▶│ MEMORY.md     │
│ (メイン agent) │     │ (即時保存)    │     │ + トピックファイル│
└─────────────┘     └──────────────┘     └───────┬───────┘
                                               │
       ┌───────────────────────────────────────┘
       ▼
┌──────────────┐     ┌──────────────┐
│ Auto Dream   │────▶│ 整理/刈り込み │
│ (バックグラウンド起動)│     │ 重複排除/訂正  │
└──────────────┘     └──────────────┘
       ▲
┌──────────────┐
│ /dream コマンド│
│ (手動起動)    │
└──────────────┘
```

- **extractMemories**（`src/services/extractMemories/`）: 各 turn の終了時に対話から新しいメモリを抽出して書き込みます。Dream は抽出を担当せず、整理だけを担当します。
- **CLAUDE.md**: コンテキストへ読み込まれるプロジェクト単位の指示ファイルであり、メモリシステムには属しません。
