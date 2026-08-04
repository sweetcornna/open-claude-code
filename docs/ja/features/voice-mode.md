<!-- lang-switcher -->
[English](/docs/en/features/voice-mode) · [中文](/docs/zh/features/voice-mode) · **日本語**

# VOICE_MODE — 音声入力

> Feature Flag: `FEATURE_VOICE_MODE=1`
> 実装状況：すべて利用可能（2 つのバックエンド：Anthropic OAuth / Doubao ASR）
> 参照数：46

## 1. 機能概要

VOICE_MODE は「押して話す」（Push-to-Talk）音声入力を実装します。ユーザーがスペースキーを押している間に録音し、音声を STT バックエンドへストリーミングします。文字起こしはリアルタイムでターミナルに表示されます。次の 2 つのバックエンドに対応します。

- **Anthropic STT（デフォルト）**：WebSocket で Nova 3 エンドポイントへストリーミングする。Anthropic OAuth が必要
- **Doubao ASR**：`doubaoime-asr` パッケージの AsyncGenerator プロトコルでストリーミング認識する。独立した認証情報ファイルを使用し、Anthropic OAuth は不要

### 主な機能

- **Push-to-Talk**：スペースキーを長押しして録音し、離すと自動送信
- **ストリーミング文字起こし**：録音中に中間結果をリアルタイム表示
- **シームレスな統合**：文字起こししたテキストをユーザーメッセージとして会話へ直接送信
- **2 バックエンドの切り替え**：`/voice` コマンドの引数で STT バックエンドを選択し、settings.json に永続化

## 2. ユーザー操作

| 操作 | 動作 |
|------|------|
| スペースキーを長押し | 録音を開始し、録音状態を表示 |
| スペースキーを離す | 録音を停止し、文字起こし結果を自動送信 |
| `/voice` | 音声モードのオンとオフを切り替える（デフォルトは Anthropic バックエンド） |
| `/voice doubao` | 音声モードを有効にし、Doubao ASR バックエンドを使用 |
| `/voice anthropic` | Anthropic STT バックエンドへ戻す |

### UI フィードバック

- **録音インジケーター**：録音中に赤色またはパルスアニメーションを表示
- **中間文字起こし**：録音中に STT のリアルタイム認識テキストを表示
- **最終文字起こし**：完了後に中間結果を置き換える

## 3. 実装アーキテクチャ

### 3.1 ゲートロジック

ファイル：`src/voice/voiceModeEnabled.ts`

2 段階のチェック関数があります。

```ts
// Anthropic バックエンド（OAuth が必要）
isVoiceModeEnabled() = hasVoiceAuth() && isVoiceGrowthBookEnabled()

// Doubao バックエンド / 一般的な利用可否チェック（OAuth は不要）
isVoiceAvailable() = isVoiceGrowthBookEnabled()
```

1. **Feature Flag**：`feature('VOICE_MODE')` — コンパイル時と実行時のスイッチ
2. **GrowthBook Kill-Switch**：`!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)` — 緊急停止スイッチ（デフォルトの false は無効化されていない状態）
3. **Auth チェック（Anthropic のみ）**：`hasVoiceAuth()` — Anthropic OAuth token が必要（API key は不可）
4. **Provider チェック**：`voiceProvider` の設定で使用するバックエンドを決定し、Doubao バックエンドは OAuth チェックを省略する

### 3.2 コアモジュール

| モジュール | 責務 |
|------|------|
| `src/voice/voiceModeEnabled.ts` | Feature flag + GrowthBook + Auth の 3 段階ゲート |
| `src/hooks/useVoice.ts` | 録音状態とバックエンド接続を管理する React hook |
| `src/services/voiceStreamSTT.ts` | Anthropic WebSocket ストリーミング STT |
| `src/services/doubaoSTT.ts` | Doubao ASR アダプター（AsyncGenerator → VoiceStreamConnection） |
| `src/commands/voice/voice.ts` | バックエンドの選択と永続化を処理する `/voice` コマンドの実装 |
| `src/hooks/useVoiceEnabled.ts` | provider に応じて OAuth を省略するか決める、音声の有効状態を管理する hook |
| `src/utils/settings/types.ts` | `voiceProvider: 'anthropic' \| 'doubao'` 設定の型定義 |

### 3.3 データフロー

#### Anthropic バックエンド

```
ユーザーがスペースキーを押す
      │
      ▼
useVoice hook が有効になる
      │
      ▼
macOS ネイティブ音声 / SoX が録音を開始
      │
      ▼
Anthropic STT エンドポイントへ WebSocket 接続
      │
      ├──→ 中間文字起こし結果 → リアルタイム表示
      │
      ▼
ユーザーがスペースキーを離す
      │
      ▼
録音を停止し、最終文字起こしを待つ
      │
      ▼
文字起こししたテキスト → 入力欄へ挿入 → 自動送信
```

#### Doubao ASR バックエンド

```
ユーザーがスペースキーを押す
      │
      ▼
useVoice hook が有効になる（voiceProvider === 'doubao' を検出）
      │
      ▼
macOS ネイティブ音声 / SoX が録音を開始
      │
      ▼
connectDoubaoStream() が AudioChunkQueue + VoiceStreamConnection を作成
      │
      ├──→ onReady が即座に発火（ハンドシェイクを待つ必要なし）
      │
      ▼
音声データを AudioChunkQueue 経由で transcribeRealtime() へ渡す
      │
      ├──→ INTERIM_RESULT → 中間文字起こしをリアルタイム表示
      ├──→ FINAL_RESULT   → 最終文字起こしを表示
      │
      ▼
ユーザーがスペースキーを離す
      │
      ▼
finalize() が即座に戻る（Doubao は録音中に結果を返しているため、待機不要）
      │
      ▼
文字起こししたテキスト → 入力欄へ挿入 → 自動送信
```

### 3.4 音声録音

2 つの音声バックエンドに対応し、両方の STT バックエンドで共有します。
- **macOS ネイティブ音声**：優先して使用。低遅延
- **SoX（Sound eXchange）**：クロスプラットフォームのフォールバック

### 3.5 Doubao ASR アダプターの設計

ファイル：`src/services/doubaoSTT.ts`

Doubao バックエンドはアダプターパターンを使用し、`doubaoime-asr` の AsyncGenerator プロトコルを `VoiceStreamConnection` インターフェースへ橋渡しします。

**AudioChunkQueue** — push 型の非同期キュー：
- `AsyncIterable<Uint8Array>` インターフェースを実装
- `push(chunk)` で音声データをキューへ追加し、`push(null)` で終了シグナルを送信
- 内部で待機中の処理（waiting）とバッファーキュー（chunks）の 2 つの状態を管理

**connectDoubaoStream()** — 接続エントリポイント：
- `doubaoime-asr` を動的に import（optionalDependencies）
- `~/.occ/tts/doubao/credentials.json` から認証情報を読み込む
- AudioChunkQueue と VoiceStreamConnection を作成
- `onReady` を即座に発火（useVoice の音声バッファーとのデッドロックを回避）
- `finalize()` は即座に戻る（Doubao は録音中に結果を返す）
- バックグラウンドの async IIFE で `transcribeRealtime` generator を消費し、レスポンスの型をコールバックへマッピング

**レスポンス型のマッピング**：

| doubaoime-asr ResponseType | コールバックのマッピング |
|----------------------------|----------|
| SESSION_STARTED | ログへ記録 |
| VAD_START | ログへ記録 |
| INTERIM_RESULT | `onTranscript(text, false)` |
| FINAL_RESULT | `onTranscript(text, true)` |
| ERROR | `onError(errorMsg)` |
| SESSION_FINISHED | ログへ記録 |

### 3.6 バックエンド選択ロジック

ファイル：`src/hooks/useVoice.ts`

```ts
// 現在の provider を判定
isDoubaoProvider() → settings.voiceProvider を読み取る

// handleKeyEvent 内の利用可否チェック
const sttAvailable = isDoubaoProvider()
  ? isDoubaoAvailableSync()    // 楽観的チェック（初回は true を返す）
  : isVoiceStreamAvailable()   // Anthropic WebSocket のチェック

// attemptConnect 内で接続関数を選択
const connectFn = isDoubaoProvider()
  ? connectDoubaoStream
  : connectVoiceStream
```

Doubao バックエンド固有の処理：
- `getVoiceKeyterms()` の呼び出しを省略（Doubao はキーワードのヒントを必要としない）
- Focus Mode を省略（`if (!enabled || !focusMode || isDoubaoProvider())`）

## 4. 重要な設計判断

1. **2 つのバックエンドを併存**：Doubao バックエンドは独立したアダプターとして Anthropic バックエンドと併存し、既存フローを置き換えない。`voiceProvider` の設定で切り替える
2. **設定の永続化**：`voiceProvider` は `settings.json` に保存され、`/voice` コマンドで変更する。セッションをまたいで有効になる
3. **OAuth は Anthropic 専用**：Anthropic バックエンドは `voice_stream` エンドポイント（claude.ai）を使うため、OAuth ユーザーのみ利用できる
4. **Doubao は OAuth 不要**：Doubao バックエンドは独立した認証情報ファイルを使用し、Anthropic の認証に依存しない。`isVoiceAvailable()` でゲートを緩和する
5. **GrowthBook の否定形ゲート**：`tengu_amber_quartz_disabled` のデフォルトは `false` であり、新規インストールでは自動的に利用できる
6. **onReady を即座に発火**：Doubao バックエンドは接続確立直後に `onReady` を発火し、useVoice の音声バッファーとのタイミング上のデッドロックを防ぐ（Anthropic は WebSocket のハンドシェイクを待つ必要がある）
7. **finalize() は即座に戻る**：Doubao は録音中にすべての結果を返すため、ユーザーがキーを離したときに処理を待つ必要がない
8. **楽観的な利用可否チェック**：`isDoubaoAvailableSync()` は初回呼び出し時に `true` を返し、実際の import エラーは `connectDoubaoStream` で処理する
9. **optionalDependencies**：`doubaoime-asr` を任意依存関係とし、インストールに失敗しても Anthropic バックエンドには影響しない

## 5. 使用方法

```bash
# feature を有効化
FEATURE_VOICE_MODE=1 bun run dev

# REPL で Anthropic バックエンドを使用
# 1. OAuth でログイン済みであることを確認（claude.ai サブスクリプション）
# 2. /voice と入力して有効化
# 3. スペースキーを押したまま話す
# 4. スペースキーを離して文字起こしを待つ

# REPL で Doubao ASR バックエンドを使用
# 1. doubaoime-asr がインストール済みであることを確認（bun add doubaoime-asr）
# 2. 認証情報ファイルを設定：~/.occ/tts/doubao/credentials.json
# 3. /voice doubao と入力して有効化
# 4. スペースキーを押したまま話す
# 5. スペースキーを離すと、文字起こし結果が即座に表示される

# バックエンドを切り替える
/voice doubao      # Doubao ASR へ切り替え
/voice anthropic   # Anthropic STT へ戻す
/voice             # 音声モードを無効化
```

### Doubao の認証情報設定

認証情報ファイルのパス：`~/.occ/tts/doubao/credentials.json`

```json
{
  "deviceId": "...",
  "installId": "...",
  "cdid": "...",
  "openudid": "...",
  "clientudid": "...",
  "token": "..."
}
```

## 6. 外部依存関係

| 依存関係 | 説明 | 対象バックエンド |
|------|------|----------|
| Anthropic OAuth | claude.ai サブスクリプションでのログイン。API key は不可 | Anthropic |
| GrowthBook | `tengu_amber_quartz_disabled` による緊急停止 | 共通 |
| macOS ネイティブ音声または SoX | 音声録音 | 共通 |
| Nova 3 STT | Anthropic の音声テキスト変換モデル | Anthropic |
| doubaoime-asr | Doubao ASR SDK（optionalDependencies） | Doubao |
| 認証情報ファイル | `~/.occ/tts/doubao/credentials.json` | Doubao |

## 7. ファイル索引

| ファイル | 責務 |
|------|------|
| `src/voice/voiceModeEnabled.ts` | 3 段階のゲートロジック + `isVoiceAvailable()` |
| `src/hooks/useVoice.ts` | React hook（録音状態 + バックエンド選択 + 接続管理） |
| `src/hooks/useVoiceEnabled.ts` | 音声の有効状態を管理する hook（provider に応じて OAuth チェックを決定） |
| `src/services/voiceStreamSTT.ts` | Anthropic STT の WebSocket ストリーミング |
| `src/services/doubaoSTT.ts` | Doubao ASR アダプター（AudioChunkQueue + connectDoubaoStream） |
| `src/commands/voice/voice.ts` | `/voice` コマンド（オンとオフ + バックエンド選択） |
| `src/commands/voice/index.ts` | コマンド登録（availability 制限を削除） |
| `src/utils/settings/types.ts` | `voiceProvider` の型定義 |
