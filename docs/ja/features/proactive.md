<!-- lang-switcher -->
[English](/docs/en/features/proactive) · [中文](/docs/zh/features/proactive) · **日本語**

# PROACTIVE — プロアクティブモード

> Feature Flag: `FEATURE_PROACTIVE=1`（`FEATURE_KAIROS=1` と機能を共有）
> 実装状況：コアループは実装済み。一部の周辺ドキュメントは引き続き整備中
> 参照数：37

## 1. 機能概要

PROACTIVE は Tick 駆動の自律エージェントを実装します。CLI はユーザーから入力がないときも作業を継続できます。一定間隔で起動してタスクを実行し、そのペースは tick スケジューラが制御します。CI の待機、ファイル変更の監視、定期チェックなど、長時間動作するバックグラウンドタスクに適しています。

### KAIROS との関係

コード上のチェックはすべて `feature('PROACTIVE') || feature('KAIROS')` です。つまり、次のように動作します。
- `FEATURE_PROACTIVE=1` だけを有効にする → proactive 機能を利用できる
- `FEATURE_KAIROS=1` だけを有効にする → proactive 機能も自動的に有効になる
- 両方を有効にする → 同じ結果になる（重複しない）

## 2. 実装アーキテクチャ

### 2.1 モジュールの状態

| モジュール | ファイル | 状態 | 説明 |
|------|------|------|------|
| コアロジック | `src/proactive/index.ts` | **実装済み** | `activateProactive()`、`deactivateProactive()`、`pause/resume`、`nextTickAt` のスケジュール状態 |
| コマンド登録 | `src/commands.ts:62-65` | **配線済み** | `./commands/proactive.js` を動的に読み込む |
| REPL 統合 | `src/screens/REPL.tsx` | **実装済み** | tick 駆動、standby 状態、フッターと bridge automation metadata の報告 |
| システムプロンプト | `src/constants/prompts.ts:864-918` | **完成** | 自律作業の動作指示（約 55 行の詳細な prompt） |
| リモートコントロールの状態ミラー | `src/utils/sessionState.ts` | **実装済み** | `automation_state` メタデータを remote-control/CCR へ公開 |

### 2.2 システムプロンプトの内容

`getProactiveSection()` が注入する自律作業の指示には、次の内容が含まれます。

| セクション | 内容 |
|------|------|
| Tick 駆動 | `<tick_tag>` prompt で動作を維持し、ユーザーのローカル時刻を含める |
| ペース制御 | tick スケジューラが起動間隔を制御する。指定時刻に起動する必要がある場合は `Monitor` の `wait_seconds` タイマーを使う。prompt cache は 5 分で期限切れになる |
| 空操作の規則 | 何もすることがなければ**そのまま turn を終了する**（何も出力しない）。"still waiting" の出力は禁止 |
| 初回起動 | 短く挨拶し、指示を待つ（自発的に探索しない） |
| 2 回目以降の起動 | 調査、検証、チェックなど、有用な作業を探す（ユーザーに spam しない） |
| 行動を優先 | ファイルの読み取り、コード検索、commit は確認不要 |
| ターミナルフォーカス | `terminalFocus` フィールドで自律性の程度を調整 |

### 2.3 データフロー

```
activateProactive()
      │
      ▼
Tick スケジューラが起動
      │
      ├── <tick_tag> メッセージを定期的に生成
      │   ├── ユーザーの現在のローカル時刻を含む
      │   └── 会話フロー（sessionStorage）へ注入
      │
      ▼
モデルが tick を処理
      │
      ├── 作業がある → ツールで実行 → turn を終了
      ├── 指定時刻に起動する必要がある → Monitor(wait_seconds) でバックグラウンド計時 → turn を終了
      └── 作業がない → turn を即座に終了（出力なし）
      │
      ▼
次の起動を待つ
      │
      ├── 次の tick が到着
      ├── Monitor の計時が終了 → task notification が起動
      └── ユーザーが新しい作業を追加 / キューにコマンドがある → 即座に起動
```

## 3. 現在の動作に関する補足

- `standby`：proactive は有効だが、現在実行中の turn はなく、次の tick はスケジュール済み。
- `sleeping`：**レガシー値**。Sleep ツールの削除後、この状態を送信するコードはありません。旧 remote-control クライアントとの互換性のためだけにプロトコルへ残されています。
- remote-control/CCR は `external_metadata.automation_state` を介して状態を受け取り、Web UI の Autopilot 状態表示に使用します。
- 「N 秒待ってからもう一度確認する」必要がある場合は、`Monitor` の `wait_seconds` モードを使います。バックグラウンドでタイマーを実行し、モデルは直ちに turn を終了します。時間になると task notification が起動します。フォアグラウンドの `Bash(sleep ...)` でブロックしてはいけません。

## 4. 重要な設計判断

1. **Tick 駆動**：外部イベントのプッシュではなく、tick スケジューラがモデルを起動します。モデルが指定時刻に起動する必要がある場合は、自身で Monitor タイマーを開始します
2. **空操作では turn を即座に終了**："still waiting" のような空メッセージによる turn と token の浪費を防ぎます
3. **Prompt cache への配慮**：cache は 5 分で期限切れになるため、待機時間を選ぶ際はバランスを取る必要があります
4. **Terminal Focus の認識**：モデルはユーザーがターミナルを見ているかどうかに応じて自律性を調整します

## 5. 使用方法

```bash
# proactive だけを有効化
FEATURE_PROACTIVE=1 bun run dev

# KAIROS を通じて間接的に有効化
FEATURE_KAIROS=1 bun run dev

# 組み合わせて使用
FEATURE_PROACTIVE=1 FEATURE_KAIROS=1 FEATURE_KAIROS_BRIEF=1 bun run dev
```

## 6. ファイル索引

| ファイル | 責務 |
|------|------|
| `src/proactive/index.ts` | コアロジックと next-tick の状態 |
| `packages/builtin-tools/src/tools/MonitorTool/MonitorTool.tsx` | Monitor ツール（`wait_seconds` タイマーモードを含む） |
| `src/constants/prompts.ts:864-918` | 自律作業のシステムプロンプト |
| `src/screens/REPL.tsx` | REPL の tick 統合と automation 状態の報告 |
| `src/utils/sessionStorage.ts:4892-4912` | Tick メッセージの注入 |
| `src/utils/sessionState.ts` | bridge/CCR metadata のミラー |
| `src/components/PromptInput/PromptInputFooterLeftSide.tsx` | フッター UI の状態 |
