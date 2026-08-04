<!-- lang-switcher -->
[English](/docs/en/features/kairos) · [中文](/docs/zh/features/kairos) · **日本語**

# KAIROS — 常駐アシスタントモード

> Feature Flag: `FEATURE_KAIROS=1`（およびサブ Feature）
> 実装状況：コアフレームワークは完成、一部のサブモジュールは stub。proactive のペース制御は利用可能
> 参照数：154（リポジトリ全体で最多）

## 1. 機能概要

KAIROS は Claude Code CLI を「質疑応答ツール」から「常駐アシスタント」へ変えます。有効にすると、CLI はバックグラウンドで継続的に動作し、次の機能を提供します。

- **永続 bridge セッション**：ターミナルを再起動しても session を再利用し、Anthropic OAuth を介して claude.ai に接続
- **バックグラウンドでのタスク実行**：ユーザーがターミナルから離れていても作業を継続（PROACTIVE feature と併用）
- **モバイル端末へのプッシュ通知**：タスク完了時や入力が必要なときに通知（`KAIROS_PUSH_NOTIFICATION` と併用）
- **日次メモリーログ**：作業内容を自動的に記録し、振り返る（`KAIROS_DREAM` と併用）
- **外部チャネルからのメッセージ受信**：Slack/Discord/Telegram のメッセージを CLI へ転送（`KAIROS_CHANNELS` と併用）
- **構造化 Brief 出力**：BriefTool を通じて構造化メッセージを出力（`KAIROS_BRIEF` と併用）

### サブ Feature の依存関係

```
KAIROS（メインスイッチ）
├── KAIROS_BRIEF（BriefTool、構造化出力）
├── KAIROS_CHANNELS（外部チャネルメッセージ）
├── KAIROS_PUSH_NOTIFICATION（モバイル端末へのプッシュ通知）
├── KAIROS_GITHUB_WEBHOOKS（GitHub PR webhook）
└── KAIROS_DREAM（メモリーの蒸留）
```

**注意**：PROACTIVE と KAIROS は強く結び付いています。コード上のチェックはすべて `feature('PROACTIVE') || feature('KAIROS')` であるため、KAIROS を有効にすると proactive 機能も自動的に有効になります。

## 2. システムプロンプト

KAIROS はシステムプロンプトに 2 つの主要セクションを注入します。

### 2.1 Brief セクション（`getBriefSection`）

ファイル：`src/constants/prompts.ts:847-858`

`feature('KAIROS') || feature('KAIROS_BRIEF')` の場合に注入されます。Brief ツール（`SendUserMessage`）で構造化メッセージを出力するための指示です。`/brief` toggle と `--brief` flag は表示フィルターだけを制御し、モデルの動作には影響しません。

### 2.2 Proactive/Autonomous Work セクション（`getProactiveSection`）

ファイル：`src/constants/prompts.ts:864-918`

`feature('PROACTIVE') || feature('KAIROS')` かつ `isProactiveActive()` の場合に注入されます。中核となる動作指示は次のとおりです。

- **Tick 駆動**：`<tick_tag>` prompt で動作を維持し、各 tick にユーザーの現在のローカル時刻を含める
- **ペース制御**：tick スケジューラが起動する。指定時刻に起動する必要がある場合は `Monitor` の `wait_seconds` タイマーを使う（prompt cache は 5 分で期限切れになる）
- **何もすることがなければ turn を即座に終了**："still waiting" のようなテキストの出力を禁止する（turn と token の浪費を防ぐ）
- **行動を優先**：ファイルの読み取り、コード検索、ファイル変更、commit はすべて確認不要
- **ターミナルフォーカスの認識**：`terminalFocus` フィールドでユーザーがターミナルを見ているかどうかを示す
  - Unfocused → 高度に自律して行動
  - Focused → より協調的に選択肢を提示

## 3. 実装アーキテクチャ

### 3.1 コアモジュール

| モジュール | ファイル | 状態 | 責務 |
|------|------|------|------|
| Assistant エントリポイント | `src/assistant/index.ts` | Stub | `isAssistantMode()`、`initializeAssistantTeam()` |
| Session 検出 | `src/assistant/sessionDiscovery.ts` | Stub | 利用可能な bridge session を検出 |
| Session 履歴 | `src/assistant/sessionHistory.ts` | Stub | session 履歴を永続化 |
| Gate 制御 | `src/assistant/gate.ts` | Stub | GrowthBook のゲートチェック |
| Session セレクター | `src/assistant/AssistantSessionChooser.ts` | Stub | session を選択する UI |
| BriefTool | `src/tools/BriefTool/` | Stub | 構造化メッセージ出力ツール |
| Channel Notification | `src/services/mcp/channelNotification.ts` | Stub | 外部チャネルからのメッセージ受信 |
| Dream Task | `src/components/tasks/src/tasks/DreamTask/` | Stub | メモリー蒸留タスク |
| Memory Directory | `src/memdir/memdir.ts` | Stub | メモリーディレクトリの管理 |

### 3.2 ペース制御（Proactive と共有）

以前の KAIROS/Proactive は、専用の `Sleep` ツールでペースを制御していました。このツールは削除済みです。proactive ではないセッションでは常に即座に `interrupted: true`（"Sleep interrupted after 0s"）を返し、さらに tick スケジューラがいずれにせよモデルを再起動するためです。

現在のモデルは次のとおりです。
- 何もすることがない → turn を即座に終了し、次の tick を待つ
- 特定の時点でもう一度確認する必要がある → `Monitor` の `wait_seconds` モードでバックグラウンドタイマーを開始し、turn を終了する。時間になると task notification が起動する
- ある*条件*が成立するまで待つ必要がある → `Monitor` の command モードで until ループを実行する
- リモートコントロールの surface からは `automation_state` を通じて `standby` を確認できる。`sleeping` は旧クライアントとの互換性のためだけに残されたレガシー値であり、現在は送信されない

### 3.3 リモートアクセス

> **変更済み（2026-07）**：以前の KAIROS は独自の Bridge Mode（`src/bridge/`）を介し、claude.ai サーバーをロングポーリングしていました。`src/bridge/` と `BRIDGE_MODE` は削除済みです。

現在のリモートアクセスは ACP を使用します。occ は ACP agent（`occ --acp`）として動作し、クライアントは [Happy](https://github.com/slopus/happy) が提供します。`occ remote-control` が両者を接続します。

```
Happy モバイルアプリ / Web
      │
      ▼（E2E 暗号化、サーバーはセルフホスト可能）
┌──────────────────────┐
│  Happy Server        │
└──────────┬───────────┘
           │ ACP over stdio
           ▼
┌──────────────────────┐
│  occ ACP Agent       │  src/services/acp/
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  REPL + Proactive    │  Tick 駆動の自律作業
│  Tick Loop           │
└──────────────────────┘
```

KAIROS のローカル機能（tick スケジューリング、Brief の構造化出力、terminal focus の認識）は、リモート転送に依存しません。単一マシンでもすべて利用できます。

## 4. 重要な設計判断

1. **イベント駆動ではなく Tick 駆動**：外部イベントをプッシュするのではなく、tick スケジューラがモデルを起動します（モデルは別途 Monitor タイマーを開始して指定時刻に起動できます）。アーキテクチャは単純になりますが、API 呼び出しのコストが増えます
2. **KAIROS ⊃ PROACTIVE**：proactive のチェックはすべて KAIROS を含むため、2 つの flag を同時に有効にする必要はありません
3. **Brief の表示と動作を分離**：`/brief` toggle は UI のフィルターだけを制御し、モデルは常に BriefTool を使用できます
4. **Terminal Focus の認識**：モデルはユーザーがターミナルを見ているかどうかに応じて、自律性を自動調整します
5. **GrowthBook のゲート**：一部の機能は feature flag を有効にしても、サーバー側の GrowthBook スイッチを有効にする必要があります

## 5. 使用方法

```bash
# 最小構成で有効化（常駐アシスタント + Brief）
FEATURE_KAIROS=1 FEATURE_KAIROS_BRIEF=1 bun run dev

# すべての機能を有効化
FEATURE_KAIROS=1 \
FEATURE_KAIROS_BRIEF=1 \
FEATURE_KAIROS_CHANNELS=1 \
FEATURE_KAIROS_PUSH_NOTIFICATION=1 \
FEATURE_KAIROS_GITHUB_WEBHOOKS=1 \
FEATURE_PROACTIVE=1 \
bun run dev

# Token Budget と併用
FEATURE_KAIROS=1 FEATURE_TOKEN_BUDGET=1 bun run dev
```

## 6. 外部依存関係

- **Anthropic OAuth**：claude.ai サブスクリプションでのログインが必須（API key は不可）
- **GrowthBook**：サーバー側の機能ゲート
- **リモートアクセス**（任意）：Happy CLI（`npm install -g happy-coder`）

## 7. ファイル索引

| ファイル | 行数 | 責務 |
|------|------|------|
| `src/assistant/index.ts` | 9 | Assistant モジュールのエントリポイント（stub） |
| `src/assistant/gate.ts` | — | GrowthBook のゲート（stub） |
| `src/assistant/sessionDiscovery.ts` | — | Session の検出（stub） |
| `src/assistant/sessionHistory.ts` | — | Session 履歴（stub） |
| `src/assistant/AssistantSessionChooser.ts` | — | Session 選択 UI（stub） |
| `src/tools/BriefTool/` | — | BriefTool の実装（stub） |
| `packages/builtin-tools/src/tools/MonitorTool/MonitorTool.tsx` | ~230 | Monitor ツール（`wait_seconds` タイマーモードを含む） |
| `src/services/mcp/channelNotification.ts` | 5 | チャネルメッセージの受信（stub） |
| `src/memdir/memdir.ts` | — | メモリーディレクトリの管理（stub） |
| `src/constants/prompts.ts:557,847-918` | 72 | システムプロンプトの注入 |
| `src/components/tasks/src/tasks/DreamTask/` | 3 | Dream タスク（stub） |
| `src/proactive/index.ts` | — | Proactive のコア（KAIROS と共有） |
| `src/utils/sessionState.ts` | — | automation 状態を bridge/CCR に公開 |
