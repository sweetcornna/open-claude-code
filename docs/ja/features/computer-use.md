<!-- lang-switcher -->
[English](/docs/en/features/computer-use) · [中文](/docs/zh/features/computer-use) · **日本語**

# Computer Use

更新日: 2026-07-31
参照プロジェクト: `E:\源码\claude-code-source-main\claude-code-source-main`

## バックエンドの選択

`computerUse.backend` は occ が Computer Use ツールを提供する方法を制御します。

| 値 | 動作 |
|---|---|
| `"builtin"` | デフォルト値。in-process の `@ant/computer-use-mcp` を登録し、このプロジェクトの承認 UI とセキュリティ層を使う。 |
| `"external"` | in-process server を登録も接続もしない。`computer-use` という名前のサーバーも組み込み予約名として扱わず、通常の MCP 設定から明示的に追加する必要がある。 |

ユーザー設定の例:

```json
{
  "computerUse": {
    "backend": "external"
  }
}
```

外部バックエンドを設定したら、実行中の occ セッションを再起動し、外部サーバーのインストール手順に従って stdio コマンドを追加します。

```bash
occ mcp add computer-use -s user -- <server-command> <server-args...>
occ mcp list
```

安定した `mcp__computer-use__*` ツール接頭辞を得るため、サーバー名には `computer-use` を推奨します。`external` モードでは、この名前も通常の stdio MCP クライアントから起動され、in-process server に置き換わりません。`builtin` へ戻す前に、同名の外部設定を削除してください。

```bash
occ mcp remove computer-use -s user
```

> **セキュリティ警告: 外部バックエンドはこのプロジェクトの Computer Use セキュリティ層を迂回します。** 外部サーバーのツール呼び出しは、
> `ComputerUseHostAdapter`、`toolCalls` dispatcher、Computer Use 承認 UI を通りません。そのため、
> `deniedApps` / `sentinelApps` policy、アプリごとの `read` / `click` / `full` 権限レベル、
> `keyBlocklist`、clipboard 保護、`pixelCompare` によるクリック検証、セッション間ロック、ESC 中止はありません。
> 提示されるのは、通常の粒度が粗い MCP ツール権限だけです。有効にする前に、サーバーとその OS 権限を独立して監査する必要があります。

調査対象になりうるコミュニティプロジェクト:

- [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP): Windows 向け
- [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use): クロスプラットフォーム指向

これらのリンクはコミュニティの選択肢を示すだけであり、このプロジェクトによる推奨、セキュリティ監査、互換性の保証を意味しません。具体的な起動コマンド、ツール名、依存関係は各プロジェクトのドキュメントに従ってください。

## Host Adapter コントラクト

`packages/@ant/computer-use-mcp/src/index.ts` が export する
`ComputerUseHostAdapter` / `ComputerExecutor` は、組み込みのセキュリティ層を維持したまま拡張するためにサポートされている挿入点です。
新しいデスクトップ host やネイティブ自動化実装の統合に適しています。`external` バックエンドとは異なる拡張方式です。
adapter による統合はこのプロジェクトの認可とセキュリティ dispatcher を引き続き通りますが、外部 MCP は実装全体を置き換えます。

公開インターフェースには次が含まれます。

```ts
import {
  bindSessionContext,
  createComputerUseMcpServer,
  type ComputerExecutor,
  type ComputerUseHostAdapter,
  type ComputerUseSessionContext,
  type CoordinateMode,
} from '@ant/computer-use-mcp'
```

host は、プロセスのライフサイクルを通じて再利用する `ComputerUseHostAdapter` と、セッションごとの
`ComputerUseSessionContext` を構築する必要があります。最も直接的な統合方法は、両方を
`createComputerUseMcpServer(adapter, coordinateMode, sessionContext)` へ渡すことです。host に既存の MCP
管理層がある場合は、`bindSessionContext()` を呼び出してセッションに bind したツール dispatch 関数を取得できます。
`sessionContext` のない `createComputerUseMcpServer()` はツール一覧の取得にしか適しておらず、ツール呼び出し handler は実際のセッション状態を受け取りません。

### `ComputerUseHostAdapter`

| メンバー | host の責務 | セキュリティ接点 |
|---|---|---|
| `serverName`, `logger` | 安定した MCP identity と 5 段階の logger 実装を提供する。ログでスクリーンショット、clipboard、アプリの内容を telemetry field にしてはならない。 | dispatch の例外を記録してツールエラーへ変換する。 |
| `executor` | 後述する OS capability を実装する。すべての非同期操作は完了後に resolve し、失敗時に reject する必要がある。 | 保護された dispatcher だけが入力を呼び出す。 |
| `ensureOsPermissions()` | 純粋なチェックだけを行い、ダイアログ表示も再起動もしない。macOS では Accessibility と Screen Recording の状態を正確に返す必要がある。 | kill switch の後、executor 呼び出し前のグローバルゲート。 |
| `isDisabled()` | host の Computer Use master switch をリアルタイムに読み取る。 | 各ツール呼び出しの最初のゲート。 |
| `getAutoUnhideEnabled()` | turn 終了時に非表示アプリを復元するかどうかの host preference を返す。 | 認可 UI で非表示化を予告するために使う。実際の cleanup は host が担当する。 |
| `getSubGates()` | 呼び出しごとに現在の `CuSubGates` を返す。動的設定を adapter 内で固定してはならない。 | スクリーンショットのクリック検証、clipboard 保護、非表示化、display 選択などの sub-gate を制御する。 |
| `cropRawPatch()` | base64 image を decode し、矩形を crop して安定した raw pixel byte を返す。失敗時は `null` を返す。 | `pixelCompare` がクリック領域の検証に使う。`null` は検証のスキップを意味し、偽の pixel を作ってはならない。 |

### `ComputerExecutor`

必須メソッドを責務ごとに示します。完全な signature は `src/executor.ts` の export interface を参照してください。

| グループ | メソッド | コントラクト要件 |
|---|---|---|
| capability | `capabilities` | `hostBundleId` は host UI を識別する必要がある。`screenshotFiltering` はアプリ単位でフィルタできるかを正確に宣言する。`platform` の現在の公開型は `darwin \| win32`。 |
| display とスクリーンショット | `getDisplaySize`, `listDisplays`, `findWindowDisplays`, `resolvePrepareCapture`, `screenshot`, `zoom` | 座標はグローバルな論理ポイントを使い、display origin を含む。`ScreenshotResult` の image size、capture 時の display size、origin、`displayId` は同一 capture に属する必要がある。`resolvePrepareCapture` は display の選択、アプリの非表示化、スクリーンショットを一貫した 1 操作として実行する。 |
| 非表示化の前処理 | `previewHideSet`, `prepareForAction` | `previewHideSet` はデスクトップを変更してはならない。`prepareForAction` は allowlist にないアプリを非表示にし、host から focus を外し、実際に非表示にした application ID を返す。Finder/デスクトップなどのプラットフォーム例外は host policy と一致させる必要がある。 |
| アプリ identity | `listInstalledApps`, `listRunningApps`, `getFrontmostApp`, `appUnderPoint`, `getAppIcon`, `openApp` | すべてのメソッドで同じ安定した application ID を使う。frontmost query と hit testing の ID は認可 grant と正確に比較できる必要がある。そうでなければアプリごとの権限レベルが機能しない。 |
| キーボードとマウス入力 | `key`, `holdKey`, `type`, `moveMouse`, `click`, `mouseDown`, `mouseUp`, `getCursorPosition`, `drag`, `scroll` | scale 済みの論理座標を受け取る。dispatcher を迂回して第 2 のグローバル入力経路を独自に起動してはならない。部分的な完了後に失敗した場合は、上位層が fail closed できるよう reject する必要がある。 |
| clipboard | `readClipboard`, `writeClipboard` | テキストを正確に読み書きし、空文字列も保持する。click-tier clipboard の一時保存、消去、復元はこの 2 メソッドに依存する。 |

Windows の window binding、UI Automation、仮想キーボード/マウス、status indicator、ターミナル起動メソッドはすべて interface 上で任意です。
未実装なら `undefined` のままにしてください。実装後は `false` / `null` で「現在 binding がない、または見つからない」ことを表し、実行障害は reject で表します。
偽の成功を返すと、モデルは誤った window state のまま操作を続けます。

プラットフォーム制約:

- `screenshotFiltering: "native"` は、スクリーンショット実装が実際に認可済みアプリだけを公開し、有効な frontmost app と coordinate hit testing を提供できることを意味する
- `screenshotFiltering: "none"` の場合、承認 UI はすべてのアプリが見える可能性をユーザーへ伝える。macOS 以外のグローバル frontmost gate も isolation guarantee として扱わない
- 公開されている `ComputerExecutorCapabilities.platform` は、現在 `darwin | win32` だけを宣言する。リポジトリ内の Linux CLI は互換層でルーティングされ、adapter コントラクトではまだ第一級の platform literal ではない
- `CoordinateMode` はツール schema の構築後に固定する必要がある。スクリーンショットとクリックをセッション途中で `pixels` から `normalized_0_100` へ切り替えてはならない

### セッション状態とセキュリティ層

`ComputerUseSessionContext` は任意の便利な wrapper ではなく、多くのセキュリティ状態に対する host boundary です。

- `onPermissionRequest` / `onTeachPermissionRequest` はユーザーに見える blocking approval を表示し、渡された `AbortSignal` に応答する必要がある。`onAllowedAppsChanged` はセッションごとの grant と grant flags を保存する
- `getAllowedApps`、`getGrantFlags`、`getUserDeniedBundleIds` は最新状態を読み取る必要がある。組み込み dispatcher はこれらに基づいて `deniedApps`、`sentinelApps`、アプリごとの権限レベルを適用する
- `checkCuLock` / `acquireCuLock` は、同時に 1 セッションだけがデスクトップを操作できることを atomic に保証する必要がある。ロックの解放は host の idle、stop、archive lifecycle が担う
- `isAborted` は host の停止操作へ接続する必要がある。host が ESC hotkey を捕捉した後も同じ abort state を更新し、batch 処理と長文入力が loop 内で停止できるようにする
- `getClipboardStash` / `onClipboardStashChanged` は click-tier clipboard 保護の状態を保存する。host は turn 終了時に、残っている stash を復元して消去する必要がある
- `onAppsHidden` はこの turn で非表示にしたアプリを記録する。host は turn 終了時または中止時に、preference に従ってアプリを復元する必要がある
- `onScreenshotCaptured` は base64 を含まないサイズメタデータを永続化する必要がある。`bindSessionContext` 自身が現在の screenshot blob を保持し、座標 scale とクリック検証に使う

セキュリティ判断は `@ant/computer-use-mcp` のツール dispatcher に残す必要があります。adapter/executor の責務は、デスクトップ状態を正確に報告し、承認された primitive を実行することであり、policy を複製したり緩和したりすることではありません。executor が投げた例外はツールエラーへ変換されます。host はそれでも、複数ステップの primitive を可能な限り idempotent にし、途中で失敗した場合にキー、マウスボタン、一時リソースを解放する必要があります。

---

## クロスプラットフォーム実装記録

## 1. 現状

参照プロジェクトの Computer Use は **macOS のみをサポート**し、エントリから低レベル実装まで darwin に固定されています。このプロジェクトでは Phase 1-3 で次を完了しています。

- ✅ `@ant/computer-use-mcp` の stub を完全な実装へ置き換え（12 ファイル）
- ✅ `@ant/computer-use-input` を dispatcher + backends（darwin + win32）へ分割
- ✅ `@ant/computer-use-swift` を dispatcher + backends（darwin + win32）へ分割
- ✅ `CHICAGO_MCP` コンパイル flag を有効化
- ✅ `src/` 層の macOS hardcoding を削除（Phase 2 完了）

## 2. blocker の一覧

### 2.1 エントリ層

| # | ファイル:行番号 | blocker code | 影響 |
|---|----------|---------|------|
| 1 | `src/main.tsx:2366` | `feature("CHICAGO_MCP")` ゲート | CU 初期化エントリ |

### 2.2 読み込み層

| # | ファイル:行番号 | blocker code | 影響 |
|---|----------|---------|------|
| 2 | `src/utils/computerUse/swiftLoader.ts` | macOS-only loader（darwin だけを読み込むよう変更済み） | darwin 以外は platforms/ を代わりに使う |
| 3 | `src/utils/computerUse/executor.ts:302` | `process.platform !== 'darwin'` → cross-platform executor | darwin 以外はクロスプラットフォーム経路を使う |

### 2.3 macOS 固有の依存関係

| # | ファイル:行番号 | 依存関係 | macOS 実装 | 必要な代替手段 |
|---|----------|------|-----------|------------|
| 4 | `executor.ts:72-96` | clipboard | `pbcopy`/`pbpaste` / PowerShell / xclip | Win: PowerShell `Get/Set-Clipboard`、Linux: `xclip`/`wl-copy` |
| 5 | `drainRunLoop.ts` | CFRunLoop pump | `cu._drainMainRunLoop()` | darwin 以外: fn() を直接実行し、pump は不要 |
| 6 | `escHotkey.ts` | ESC hotkey | CGEventTap | darwin 以外: false を返す（既存の Ctrl+C fallback を使う） |
| 7 | `hostAdapter.ts` | OS 権限 | TCC accessibility + screenRecording | Win: そのまま granted。Linux: xdotool を確認 |
| 8 | `common.ts:55-58` | platform identity | 動的に取得 | `process.platform` で dispatch するよう変更済み |
| 9 | `executor.ts:232` | paste shortcut | `command`/`ctrl` の dispatch | platform に応じて paste shortcut を dispatch するよう変更済み |

### 2.4 未実装の Linux backend

| package | macOS | Windows | Linux |
|---|-------|---------|-------|
| `computer-use-input/backends/` | ✅ darwin.ts | ✅ win32.ts | ❌ linux.ts の新規作成が必要 |
| `computer-use-swift/backends/` | ✅ darwin.ts | ✅ win32.ts | ❌ linux.ts の新規作成が必要 |

## 3. プラットフォームごとの capability 依存関係

### 3.1 computer-use-input（キーボード/マウス）

| 機能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| マウス移動 | CGEvent JXA | SetCursorPos P/Invoke | xdotool mousemove |
| マウスクリック | CGEvent JXA | SendInput P/Invoke | xdotool click |
| マウスホイール | CGEvent JXA | SendInput MOUSEEVENTF_WHEEL | xdotool scroll |
| キー入力 | System Events osascript | keybd_event P/Invoke | xdotool key |
| key combination | System Events osascript | keybd_event の組み合わせ | xdotool key combo |
| テキスト入力 | System Events keystroke | SendKeys.SendWait | xdotool type |
| frontmost app | System Events osascript | GetForegroundWindow P/Invoke | xdotool getactivewindow + /proc |
| ツール依存関係 | osascript（組み込み） | powershell（組み込み） | xdotool（インストールが必要） |

### 3.2 computer-use-swift（スクリーンショット + アプリ管理）

| 機能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 全画面スクリーンショット | screencapture | CopyFromScreen | gnome-screenshot / scrot / grim |
| 領域スクリーンショット | screencapture -R | CopyFromScreen(rect) | gnome-screenshot -a / scrot -a / grim -g |
| display list | CGGetActiveDisplayList JXA | Screen.AllScreens | xrandr --query |
| 実行中アプリ | System Events JXA | Get-Process | wmctrl -l / ps |
| アプリを開く | osascript activate | Start-Process | xdg-open / gtk-launch |
| 非表示/表示 | System Events visibility | ShowWindow/SetForegroundWindow | wmctrl -c / xdotool |
| ツール依存関係 | screencapture + osascript | powershell | xdotool + scrot/grim + wmctrl |

### 3.3 executor 層

| 機能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| drainRunLoop | CFRunLoop pump | 不要 | 不要 |
| ESC hotkey | CGEventTap | スキップ（Ctrl+C fallback） | スキップ（Ctrl+C fallback） |
| clipboard read | pbpaste | `powershell Get-Clipboard` | xclip -o / wl-paste |
| clipboard write | pbcopy | `powershell Set-Clipboard` | xclip / wl-copy |
| paste shortcut | command+v | ctrl+v | ctrl+v |
| ターミナル検出 | __CFBundleIdentifier | WT_SESSION / TERM_PROGRAM | TERM_PROGRAM |
| OS 権限 | TCC check | そのまま granted | xdotool のインストールを確認 |

## 4. 実施手順

### Phase 1: 完了 ✅

- [x] `@ant/computer-use-mcp` stub → 完全な実装
- [x] `@ant/computer-use-input` dispatcher + darwin/win32 backends
- [x] `@ant/computer-use-swift` dispatcher + darwin/win32 backends
- [x] `CHICAGO_MCP` コンパイル flag

### Phase 2: 6 箇所の macOS hardcoding を削除（macOS + Windows を利用可能にする）

**変更方針: macOS の code path は変更せず、各 darwin guard の後ろに win32/linux 分岐だけを追加する。**

| 手順 | ファイル | 変更 |
|------|------|------|
| 2.1 | `src/main.tsx:2366` | `feature("CHICAGO_MCP")` → クロスプラットフォームのエントリに変更済み |
| 2.2 | `src/utils/computerUse/swiftLoader.ts` | darwin だけを読み込むよう変更済み。darwin 以外は platforms/ を使う |
| 2.3 | `src/utils/computerUse/executor.ts:302-309` | cross-platform dispatch へ変更済み（darwin 以外 → createCrossPlatformExecutor） |
| 2.4 | `src/utils/computerUse/executor.ts:72-96` | clipboard を platform ごとに dispatch 済み: darwin→pbcopy/pbpaste、win32→PowerShell、linux→xclip |
| 2.5 | `src/utils/computerUse/executor.ts:232` | paste shortcut を platform ごとに dispatch 済み: darwin→command、その他→ctrl |
| 2.6 | `src/utils/computerUse/executor.ts:302-309` | darwin 以外を `createCrossPlatformExecutor()` へ変更済み |
| 2.7 | `src/utils/computerUse/drainRunLoop.ts` | darwin 以外は pump 不要（fn を直接実行） |
| 2.8 | `src/utils/computerUse/escHotkey.ts` | darwin 以外は false を返す（既存の Ctrl+C fallback を使う） |
| 2.9 | `src/utils/computerUse/hostAdapter.ts` | darwin 以外の権限チェックロジックを実装済み |
| 2.10 | `src/utils/computerUse/common.ts:58` | `process.platform` による動的 dispatch へ変更済み |
| 2.11 | `src/utils/computerUse/common.ts:55` | darwin→'native'、その他→'none' に変更済み |
| 2.12 | `src/utils/computerUse/gates.ts:55` | 更新済み（enabled のデフォルト値は検証が必要） |
| 2.13 | `src/utils/computerUse/gates.ts:39` | `hasRequiredSubscription()` を更新済み |

### Phase 3: Linux backend の追加

| 手順 | ファイル | 内容 |
|------|------|------|
| 3.1 | `packages/@ant/computer-use-input/src/backends/linux.ts` | xdotool によるキーボード/マウス操作（mousemove/click/key/type/getactivewindow） |
| 3.2 | `packages/@ant/computer-use-swift/src/backends/linux.ts` | scrot/grim screenshot + xrandr display + wmctrl window management |
| 3.3 | `packages/@ant/computer-use-input/src/index.ts` | dispatcher に `case 'linux'` を追加 |
| 3.4 | `packages/@ant/computer-use-swift/src/index.ts` | dispatcher に `case 'linux'` を追加 |

### Phase 4: 検証

| テスト項目 | macOS | Windows | Linux |
|--------|-------|---------|-------|
| build 成功 | ✅ | 検証 | 検証 |
| MCP ツール一覧が空でない | 検証 | 検証 | 検証 |
| マウス移動 | 検証 | ✅ 検証済み | 検証 |
| スクリーンショット | 検証 | ✅ 検証済み | 検証 |
| キー入力 | 検証 | 検証 | 検証 |
| frontmost window | 検証 | ✅ 検証済み | 検証 |
| clipboard | 検証 | 検証 | 検証 |

## 5. ファイル変更の概要

### 変更しないファイル（14 個）

`cleanup.ts`、`computerUseLock.ts`、`wrapper.tsx`、`toolRendering.tsx`、`mcpServer.ts`、`setup.ts`、`appNames.ts`、`inputLoader.ts`、`src/services/mcp/client.ts`、`@ant/computer-use-mcp/src/*`（Phase 1 で完了済み）、`backends/darwin.ts`（両 package とも変更しない）

### 変更する src/ ファイル（8 個）

| ファイル | 変更量 | リスク |
|------|--------|------|
| `main.tsx` | 1 行 | 低 |
| `swiftLoader.ts` | 2 行 | 低 |
| `executor.ts` | ~40 行（clipboard dispatch + platform guard + paste shortcut） | **中** |
| `drainRunLoop.ts` | 1 行 | 低 |
| `escHotkey.ts` | 3 行 | 低 |
| `hostAdapter.ts` | 5 行 | 低 |
| `common.ts` | 3 行 | 低 |
| `gates.ts` | 3 行 | 低 |

### 新規ファイル（2 個）

| ファイル | 推定行数 |
|------|---------|
| `packages/@ant/computer-use-input/src/backends/linux.ts` | ~150 行 |
| `packages/@ant/computer-use-swift/src/backends/linux.ts` | ~200 行 |

## 6. Linux の依存ツール

| ツール | 用途 | インストールコマンド（Ubuntu） |
|------|------|-------------------|
| `xdotool` | キーボード/マウスのエミュレーション + window management | `sudo apt install xdotool` |
| `scrot` または `gnome-screenshot` | スクリーンショット | `sudo apt install scrot` |
| `xrandr` | display 情報 | 通常はプリインストール済み |
| `xclip` | clipboard | `sudo apt install xclip` |
| `wmctrl` | window list/切り替え | `sudo apt install wmctrl` |

Wayland 環境では代替ツールが必要です。`ydotool`（xdotool の代替）、`grim`（scrot の代替）、`wl-clipboard`（xclip の代替）を使います。初期段階では X11 だけをサポートし、Wayland を todo として扱えます。

## 7. 推奨実施順序

```
Phase 2（macOS + Windows を利用可能にする）
  ├── 2.1-2.3  3 箇所の hardcoded throw/skip を削除
  ├── 2.4-2.5  clipboard + paste shortcut を platform ごとに dispatch
  ├── 2.6      swiftLoader → 直接インスタンス化
  ├── 2.7-2.9  drainRunLoop / escHotkey / permissions の platform 分岐
  ├── 2.10-2.11 common.ts の platform identity を動的化
  ├── 2.12-2.13 gates.ts のデフォルト値
  └── Windows を検証

Phase 3（Linux backend）
  ├── 3.1  input/backends/linux.ts
  ├── 3.2  swift/backends/linux.ts
  ├── 3.3-3.4  dispatcher に linux case を追加
  └── Linux を検証

Phase 4（統合検証 + PR）
```

各 Phase は独立して検証、commit できます。Phase 2 が完了すると macOS + Windows が利用でき、Phase 3 が完了すると 3 プラットフォームすべてが利用できます。
