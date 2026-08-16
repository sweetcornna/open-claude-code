<!-- lang-switcher -->
[English](/docs/en/features/daemon) · [中文](/docs/zh/features/daemon) · **日本語**

# DAEMON — バックグラウンドデーモン

> Feature Flag: `FEATURE_DAEMON=1`
> 実装状況: Supervisor と remoteControl Worker は実装済み
> 参照数: 3

## 1. 機能概要

DAEMON は occ をバックグラウンドデーモンに切り替えます。メインプロセス（supervisor）が複数の worker サブプロセスのライフサイクルを管理し、ファイルシステム上の状態ファイルを介して通信します。

> **`remoteControl` supervisor worker が登録されています。** `runBridgeHeadless()` で公式 endpoint またはセルフホスト RCS に接続してリモート session を受け付けます。supervisor はクラッシュ再起動、指数バックオフ、永久エラーの parking を担当します。バックグラウンドセッションのサブコマンド（`daemon bg` / `attach` / `logs` / `kill`、`BG_SESSIONS` でゲート）はこの worker から独立しています。

## 2. 実装アーキテクチャ

### 2.1 モジュールの状態

| モジュール | ファイル | 状態 |
|------|------|------|
| デーモンのメインプロセス | `src/daemon/main.ts` | **実装済み** — Supervisor はサブコマンド、Worker のライフサイクル管理、指数バックオフによる再起動を含む |
| Worker の登録 | `src/daemon/workerRegistry.ts` | **実装済み** — `remoteControl` を登録し `runBridgeHeadless()` を実行 |
| Daemon の状態 | `src/daemon/state.ts` | **実装済み** — PID/状態ファイルの読み書きと照会 |
| CLI ルーティング | `src/entrypoints/cli.tsx` | **配線済み** — `--daemon-worker` と `daemon` サブコマンド |
| コマンド登録 | `src/commands.ts` | **配線済み** — DAEMON ゲート |

### 2.2 CLI エントリポイント

```
# デーモンを起動
occ daemon start

# 状態を表示（デフォルトのサブコマンド）
occ daemon status
occ daemon ps

# デーモンを停止
occ daemon stop

# worker として起動（supervisor が自動的に呼び出す）
occ --daemon-worker=remoteControl

# バックグラウンドセッションの管理
occ daemon bg
occ daemon attach <session>
occ daemon logs <session>
occ daemon kill <session>
```

### 2.3 アーキテクチャ

```
Supervisor (daemonMain)
      │
      ├── Worker: remoteControl
      │   └── runBridgeHeadless() — リモートコントロールの headless モード
      │       リモートセッションの受信、メッセージ処理、権限承認
      │
      ▼
ファイルシステム上の状態ファイル (daemon-state.json)
  - PID、CWD、起動時刻、Worker の種類
  - queryDaemonStatus() / stopDaemonByPid()
```

### 2.4 Worker のライフサイクル管理

Supervisor は各 worker に対して次を実装します。
- **指数バックオフによる再起動**: 初期値 2s、上限 120s、倍率 ×2
- **短時間での失敗検出**: 10s 以内に 5 回連続でクラッシュすると parking（以後は再起動しない）
- **永続エラーの終了コード**: 78 (EXIT_CODE_PERMANENT) なら即座に parking
- **正常終了**: SIGTERM/SIGINT → abort signal → 30s 後に強制 SIGKILL

### 2.5 新しい worker の登録

`src/daemon/workerRegistry.ts` の `DAEMON_WORKER_KINDS` に kind 名を追加し、`runDaemonWorker()` で処理します。supervisor はこの一覧に従って `occ --daemon-worker=<kind>` を spawn し、それ以外（バックオフ、parking、正常終了、状態ファイル）は自動的に有効になります。

## 3. 主要な設計判断

1. **マルチプロセスアーキテクチャ**: 1 つの supervisor + 複数の worker によるプロセス分離
2. **ファイルシステムによる状態通信**: `daemon-state.json` ファイルを介して状態を共有する（Unix ドメインソケットではない）
3. **worker と supervisor の分離**: worker kind は拡張可能なレジストリであり、supervisor は具体的な worker を一切認識しない
4. **CLI サブコマンドのルーティング**: `daemon` サブコマンドと `--daemon-worker` 引数は `cli.tsx` でルーティングする
5. **Worker の環境変数**: supervisor は環境変数（`DAEMON_WORKER_*`）を介して worker に設定を渡す

## 4. 使用方法

```bash
# デーモンモードを有効化
FEATURE_DAEMON=1 bun run dev

# デーモンを起動
occ daemon start

# 状態を表示
occ daemon status

# デーモンを停止
occ daemon stop

# 特定の worker として起動（通常は supervisor が自動的に呼び出す）
occ --daemon-worker=remoteControl
```

## 5. ファイル索引

| ファイル | 責務 |
|------|------|
| `src/daemon/main.ts` | Supervisor のメインプロセス: サブコマンドのディスパッチ、Worker のライフサイクル管理、バックオフによる再起動 |
| `src/daemon/workerRegistry.ts` | Worker エントリポイント: remoteControl worker の実装 |
| `src/daemon/state.ts` | Daemon の状態管理: PID ファイルの読み書き、状態の照会 |
| `src/entrypoints/cli.tsx` | CLI ルーティング |
| `src/commands.ts` | コマンド登録（二重ゲート） |
