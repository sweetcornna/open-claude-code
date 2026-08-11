<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/voice-mode) · [日本語](/docs/ja/features/voice-mode)

# VOICE_MODE — Voice Input

> Feature Flag: `FEATURE_VOICE_MODE=1`
> Implementation status: Fully available with two backends, Anthropic OAuth and Doubao ASR
> References: 46

## 1. Feature overview

VOICE_MODE implements Push-to-Talk voice input. The user holds the spacebar to record audio, which streams to the STT backend while live transcription appears in the terminal. Two backends are supported:

- **Anthropic STT (default)**: Streams over WebSocket to the Nova 3 endpoint and requires Anthropic OAuth
- **Doubao ASR**: Streams recognition through the `doubaoime-asr` package's AsyncGenerator protocol, uses a separate credentials file, and does not require Anthropic OAuth

### Core capabilities

- **Push-to-Talk**: Hold the spacebar to record, then release it to submit automatically
- **Streaming transcription**: Display interim transcription results while recording
- **Seamless integration**: Submit transcribed text directly to the conversation as a user message
- **Backend selection**: Select an STT backend through `/voice` command arguments and persist the selection to settings.json

## 2. User interaction

| Action | Behavior |
|------|------|
| Hold the spacebar | Start recording and display the recording state |
| Release the spacebar | Stop recording and submit the transcription automatically |
| `/voice` | Toggle voice mode, using the Anthropic backend by default |
| `/voice doubao` | Enable voice mode with the Doubao ASR backend |
| `/voice anthropic` | Switch back to the Anthropic STT backend |

### UI feedback

- **Recording indicator**: Displays a red/pulsing animation while recording
- **Interim transcription**: Displays live STT recognition text while recording
- **Final transcription**: Replaces the interim result when transcription completes

## 3. Implementation architecture

### 3.1 Gating logic

File: `src/voice/voiceModeEnabled.ts`

Two checking functions:

```ts
// Anthropic backend (requires OAuth)
isVoiceModeEnabled() = hasVoiceAuth() && isVoiceGrowthBookEnabled()

// Doubao backend / general availability check (does not require OAuth)
isVoiceAvailable() = isVoiceGrowthBookEnabled()
```

**The three backends differ sharply in who can reach them**, which is the part most easily missed when picking a default:

| `voiceProvider` | Requires | Who can use it |
|---|---|---|
| `anthropic` (default) | A claude.ai OAuth token | First-party logins only. API keys, Bedrock, Vertex, Foundry and every third-party provider fail the check |
| `doubao` | Nothing | **Dead** — the package impersonates a retired ByteDance app build and now answers `service discovery failure` |
| `local` | Nothing (offline after the first download) | Everyone |

Before 2.38.x that left users on a third-party provider with no working voice backend at all: the default demanded a credential they cannot obtain, and the other one was broken. `local` exists for them.

1. **Feature Flag**: `feature('VOICE_MODE')` — compile-time/runtime switch
2. **GrowthBook Kill-Switch**: `!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)` — emergency disable switch; false by default means enabled
3. **Authentication check (Anthropic only)**: `hasVoiceAuth()` — requires an Anthropic OAuth token, not an API key
4. **Provider check**: The `voiceProvider` setting selects the backend; the Doubao backend skips the OAuth check

### 3.2 Core modules

| Module | Responsibility |
|------|------|
| `src/voice/voiceModeEnabled.ts` | Three-layer gating through the feature flag, GrowthBook, and authentication |
| `src/hooks/useVoice.ts` | React hook that manages recording state and backend connections |
| `src/services/voiceStreamSTT.ts` | Anthropic WebSocket streaming STT |
| `src/services/doubaoSTT.ts` | Doubao ASR adapter from AsyncGenerator to VoiceStreamConnection |
| `src/commands/voice/voice.ts` | `/voice` command implementation for backend selection and persistence |
| `src/hooks/useVoiceEnabled.ts` | Voice-enabled state hook that determines whether to skip OAuth based on the provider |
| `src/utils/settings/types.ts` | Type definition for the `voiceProvider: 'anthropic' \| 'doubao'` setting |

### 3.3 Data flow

#### Anthropic backend

```
User presses the spacebar
      │
      ▼
useVoice hook activates
      │
      ▼
Native macOS audio / SoX starts recording
      │
      ▼
WebSocket connects to the Anthropic STT endpoint
      │
      ├──→ Interim transcription → display in real time
      │
      ▼
User releases the spacebar
      │
      ▼
Stop recording and await final transcription
      │
      ▼
Transcribed text → insert into input field → submit automatically
```

#### Doubao ASR backend

```
User presses the spacebar
      │
      ▼
useVoice hook activates (detects voiceProvider === 'doubao')
      │
      ▼
Native macOS audio / SoX starts recording
      │
      ▼
connectDoubaoStream() creates AudioChunkQueue + VoiceStreamConnection
      │
      ├──→ onReady fires immediately (no handshake wait)
      │
      ▼
Audio data enters transcribeRealtime() through AudioChunkQueue
      │
      ├──→ INTERIM_RESULT → display interim transcription in real time
      ├──→ FINAL_RESULT   → display final transcription
      │
      ▼
User releases the spacebar
      │
      ▼
finalize() returns immediately (Doubao already returned results during recording; no wait required)
      │
      ▼
Transcribed text → insert into input field → submit automatically
```

#### Local backend (sherpa-onnx, offline)

The third backend, and the only one that needs no account at all: `voiceProvider: 'local'`. On first use it downloads a recognizer and a model into `<config dir>/stt/`; after that it is fully offline — no key, no quota, no outbound request.

It lives in `src/services/localStt/` (catalog, install, digest verification, extraction, transcription) and `src/services/localSttStream.ts`, which adapts it to the same streaming interface the other two backends expose.

**Recognition runs in a CHILD PROCESS, not inside occ.** That is a hard requirement: occ's resident RSS is ~35 MB, reached by splitting the bundle down from ~1 GB (see `memory-footprint.md`), and loading a model in-process would hand all of that back. The child exits when the utterance ends and its memory goes with it.

**Why sherpa-onnx rather than whisper.cpp.** whisper.cpp's release page publishes Linux and Windows binaries but **no macOS CLI**; the remaining options there are a Homebrew bottle (works only where brew exists) or building from source (requires a toolchain on the user's machine). sherpa-onnx publishes a prebuilt CLI for all eight platform/arch combinations. Windows uses the `MT` (static CRT) builds so the feature never demands the Visual C++ redistributable, and `no-tts` builds are preferred where published — the synthesis half roughly doubles the extracted size.

**Every artifact is pinned by version and digest**, and the digests come from the GitHub / Hugging Face metadata APIs — never from the download itself. A mismatch fails the install loudly instead of running an unverified binary. Bumping `SHERPA_ONNX_VERSION` means re-reading the release's `digest` fields and replacing every url/sha256/bytes triple in `catalog.ts`.

##### Choosing a model

Measured on macOS arm64 (5.28 s Chinese sample, `--num-threads=2`):

| Model | Download | Peak RSS | RTF | Chinese | English |
|---|---|---|---|---|---|
| `sense-voice` (default) | 226 MB | 555 MB | 0.054 | Character-perfect | Usable, technical terms suffer |
| `paraformer-zh-small` | 78 MB | **225 MB** | **0.013** | Character-perfect | Unusable |
| `whisper-tiny` | 99 MB | — | — | — | — |

**For Chinese-only dictation, pick `paraformer-zh-small`**: identical accuracy, less than half the memory, four times faster, a third of the download. The default is `sense-voice` because it also covers English, Japanese, Korean and Cantonese, whereas Paraformer is Chinese-only — feeding it English yields output like `please refacor the redry clasassiation`.

Neither model is good at English technical vocabulary (`retry` → `RERY`, `test suite` → `TET WEEK`). That is a property of the models, not of how they are wired in.

The peak-RSS column is the **child** process; it is released when the utterance ends and occ's own RSS is unaffected.

### 3.4 Audio recording

Both STT backends share support for two audio backends:
- **Native macOS audio**: Preferred for low latency
- **SoX (Sound eXchange)**: Cross-platform fallback

### 3.5 Doubao ASR adapter design

File: `src/services/doubaoSTT.ts`

The Doubao backend uses the adapter pattern to bridge the `doubaoime-asr` AsyncGenerator protocol to the `VoiceStreamConnection` interface:

**AudioChunkQueue** — push-based asynchronous queue:
- Implements the `AsyncIterable<Uint8Array>` interface
- `push(chunk)` enqueues audio data, and `push(null)` sends the end signal
- Maintains two internal states: waiters (waiting) and the buffered queue (chunks)

**connectDoubaoStream()** — connection entry point:
- Dynamically imports `doubaoime-asr` from optionalDependencies
- Loads credentials from `~/.occ/tts/doubao/credentials.json`
- Creates AudioChunkQueue and VoiceStreamConnection
- Fires `onReady` immediately to avoid a timing deadlock with useVoice audio buffering
- `finalize()` returns immediately because Doubao returns results during recording
- A background async IIFE consumes the `transcribeRealtime` generator and maps response types to callbacks

**Response type mapping**:

| doubaoime-asr ResponseType | Callback mapping |
|----------------------------|----------|
| SESSION_STARTED | Log entry |
| VAD_START | Log entry |
| INTERIM_RESULT | `onTranscript(text, false)` |
| FINAL_RESULT | `onTranscript(text, true)` |
| ERROR | `onError(errorMsg)` |
| SESSION_FINISHED | Log entry |

### 3.6 Backend-selection logic

File: `src/hooks/useVoice.ts`

```ts
// Determine the current provider
isDoubaoProvider() → read settings.voiceProvider

// Availability check in handleKeyEvent
const sttAvailable = isDoubaoProvider()
  ? isDoubaoAvailableSync()    // optimistic check (returns true on the first call)
  : isVoiceStreamAvailable()   // Anthropic WebSocket check

// Select the connection function in attemptConnect
const connectFn = isDoubaoProvider()
  ? connectDoubaoStream
  : connectVoiceStream
```

Special handling for the Doubao backend:
- Skip the `getVoiceKeyterms()` call because Doubao does not require keyword hints
- Skip Focus Mode (`if (!enabled || !focusMode || isDoubaoProvider())`)

## 4. Key design decisions

1. **Two coexisting backends**: The Doubao backend exists as an independent adapter alongside the Anthropic backend instead of replacing the existing flow. The `voiceProvider` setting selects between them.
2. **Persistent settings**: `voiceProvider` is stored in `settings.json`, changed through the `/voice` command, and retained across sessions.
3. **OAuth exclusivity for Anthropic**: The Anthropic backend uses the `voice_stream` endpoint on claude.ai and is available only to OAuth users.
4. **No OAuth requirement for Doubao**: The Doubao backend uses a separate credentials file and does not depend on Anthropic authentication. `isVoiceAvailable()` relaxes the gate accordingly.
5. **Negative GrowthBook gate**: `tengu_amber_quartz_disabled` defaults to `false`, so new installations are enabled automatically.
6. **Immediate onReady**: The Doubao backend fires `onReady` immediately after establishing the connection to avoid a timing deadlock with useVoice audio buffering. Anthropic must wait for the WebSocket handshake.
7. **Immediate finalize() return**: Doubao returns all results during recording, so processing does not need to continue after the user releases the key.
8. **Optimistic availability check**: `isDoubaoAvailableSync()` returns `true` on its first call; `connectDoubaoStream` handles actual import errors.
9. **optionalDependencies**: `doubaoime-asr` is an optional dependency, so an installation failure does not affect the Anthropic backend.

## 5. Usage

```bash
# Enable the feature
FEATURE_VOICE_MODE=1 bun run dev

# Use the Anthropic backend in the REPL
# 1. Ensure that you have signed in through OAuth with a claude.ai subscription
# 2. Enter /voice to enable it
# 3. Hold the spacebar and speak
# 4. Release the spacebar and wait for transcription

# Use the Doubao ASR backend in the REPL
# 1. Ensure that doubaoime-asr is installed (bun add doubaoime-asr)
# 2. Configure the credentials file: ~/.occ/tts/doubao/credentials.json
# 3. Enter /voice doubao to enable it
# 4. Hold the spacebar and speak
# 5. Release the spacebar; the transcription appears immediately

# Switch backends
/voice doubao      # Switch to Doubao ASR
/voice anthropic   # Switch back to Anthropic STT
/voice             # Disable voice mode
```

### Doubao credentials configuration

Credentials file path: `~/.occ/tts/doubao/credentials.json`

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

## 6. External dependencies

| Dependency | Description | Applicable backend |
|------|------|----------|
| Anthropic OAuth | claude.ai subscription login, not an API key | Anthropic |
| GrowthBook | Emergency disable through `tengu_amber_quartz_disabled` | General |
| Native macOS audio or SoX | Audio recording | General |
| Nova 3 STT | Anthropic speech-to-text model | Anthropic |
| doubaoime-asr | Doubao ASR SDK in optionalDependencies | Doubao |
| Credentials file | `~/.occ/tts/doubao/credentials.json` | Doubao |

## 7. File index

| File | Responsibility |
|------|------|
| `src/voice/voiceModeEnabled.ts` | Three-layer gating logic and `isVoiceAvailable()` |
| `src/hooks/useVoice.ts` | React hook for recording state, backend selection, and connection management |
| `src/hooks/useVoiceEnabled.ts` | Voice-enabled state hook that determines the OAuth check by provider |
| `src/services/voiceStreamSTT.ts` | Anthropic STT streaming over WebSocket |
| `src/services/doubaoSTT.ts` | Doubao ASR adapter using AudioChunkQueue and connectDoubaoStream |
| `src/commands/voice/voice.ts` | `/voice` command for toggling and backend selection |
| `src/commands/voice/index.ts` | Command registration with the availability restriction removed |
| `src/utils/settings/types.ts` | `voiceProvider` type definition |
