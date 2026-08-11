/**
 * Artifact catalog for the local (offline) speech-to-text backend.
 *
 * WHY THESE ARTIFACTS
 *
 * occ's other two STT backends are both unreachable for most users: the
 * Anthropic `voice_stream` endpoint needs a claude.ai OAuth token (no API
 * key, Bedrock, Vertex, Foundry or third-party provider qualifies), and the
 * Doubao backend impersonated a retired ByteDance app build. This backend
 * needs no account, no key and no network after the first setup.
 *
 * The recognizer is sherpa-onnx's standalone `sherpa-onnx-offline`
 * executable, taken from the project's GitHub releases. It was chosen over
 * whisper.cpp for one blunt reason: whisper.cpp's release page publishes
 * Linux and Windows binaries but no macOS CLI at all, and the alternatives
 * for macOS are a Homebrew bottle (fails "not just where Homebrew exists")
 * or building from source (fails "no compilation on the user's machine").
 * sherpa-onnx publishes a prebuilt CLI for all eight combinations below.
 *
 * The archives are `.tar.bz2`, which is why bzip2.ts and tar.ts exist —
 * see the comment at the top of bzip2.ts for why shelling out to `tar` was
 * not acceptable here.
 *
 * Windows uses the `MT` (static CRT) builds deliberately: the `MD` builds
 * need the Visual C++ redistributable installed, which a voice feature has
 * no business demanding. `no-tts` builds are used where published — occ
 * only needs the recognizer, and the speech-synthesis half roughly doubles
 * the extracted size.
 *
 * Everything is pinned by version and digest. Bumping SHERPA_ONNX_VERSION
 * means re-reading
 * https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/<tag> and
 * replacing every url/sha256/bytes triple below from the `digest` field
 * GitHub publishes per asset; a stale digest fails the install loudly
 * instead of running an unverified binary.
 *
 * Models come from the sherpa-onnx author's Hugging Face repos. Large files
 * there are Git-LFS backed and the tree API exposes their content sha256
 * (`lfs.oid`); the small `tokens.txt` files are stored as ordinary git blobs
 * and only have a git object id, so they are verified by git blob SHA-1
 * instead. Both values come from the metadata API, never from the download.
 */

/** Platform/arch combinations sherpa-onnx publishes a wheel for. */
export type LocalSttPlatformKey =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'linux-arm'
  | 'win32-x64'
  | 'win32-arm64'
  | 'win32-ia32'

type RuntimeArtifact = {
  /** Archive file name, used for cache dir naming and error messages. */
  fileName: string
  url: string
  sha256: string
  bytes: number
}

/** Pinned upstream release. See the module comment before changing. */
export const SHERPA_ONNX_VERSION = '1.13.5'

const RELEASE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`

function releaseArtifact(fileName: string, sha256: string, bytes: number) {
  return { fileName, url: `${RELEASE}/${fileName}`, sha256, bytes }
}

export const RUNTIME_ARTIFACTS: Readonly<
  Record<LocalSttPlatformKey, RuntimeArtifact>
> = {
  'darwin-arm64': releaseArtifact(
    'sherpa-onnx-v1.13.5-osx-arm64-shared-no-tts.tar.bz2',
    '77c46d0e7d383735b7dd9713313ddf764815e829503b0b917ff51ac31be2e897',
    17880704,
  ),
  'darwin-x64': releaseArtifact(
    'sherpa-onnx-v1.13.5-osx-x64-shared-no-tts.tar.bz2',
    'a4e1c0cb51511e0b5716c93cf6b81933df3f6cf64249775edddbb6ffe068819a',
    20303910,
  ),
  'linux-x64': releaseArtifact(
    'sherpa-onnx-v1.13.5-linux-x64-shared-no-tts.tar.bz2',
    'a39369615d610cb835f225b6b7fbff684aedf46557eab8a90e1ccc11fac84166',
    24526724,
  ),
  // No `-no-tts` variant is published for aarch64; `-cpu` is the plain CPU
  // build, as opposed to the CUDA ones.
  'linux-arm64': releaseArtifact(
    'sherpa-onnx-v1.13.5-linux-aarch64-shared-cpu.tar.bz2',
    'f38b97f478c4196d2f3279f847a3de62672d0d64b3845df9bae83bb5f48d0d34',
    27778829,
  ),
  'linux-arm': releaseArtifact(
    'sherpa-onnx-v1.13.5-linux-arm-gnueabihf-shared.tar.bz2',
    '0238ef377aa8618d1c40c3d1743de21fbd287ab45c4484aa32fc65d115d74857',
    32363609,
  ),
  'win32-x64': releaseArtifact(
    'sherpa-onnx-v1.13.5-win-x64-shared-MT-Release-no-tts.tar.bz2',
    '7c9dbcd3d38f71e2ee25dafc270e91d30f0684be8526c3c19cac1aedb073033d',
    22925630,
  ),
  'win32-arm64': releaseArtifact(
    'sherpa-onnx-v1.13.5-win-arm64-shared-MT-Release-no-tts.tar.bz2',
    'ccb4900325ff6d5d51d538f78d728e4a248586609a7ed456b0c2c8ec2de3ba6f',
    21466293,
  ),
  'win32-ia32': releaseArtifact(
    'sherpa-onnx-v1.13.5-win-x86-shared-MT-Release-no-tts.tar.bz2',
    '0b011f0e92b50786cd1014f1a43674e57c702168a4d0604e30ea44e2bf80db7c',
    19478142,
  ),
}

/**
 * Map a Node platform/arch pair onto a published wheel.
 *
 * Returns null for anything upstream does not build — the caller must turn
 * that into an actionable message naming the platform, never a silent
 * fallback to a different backend.
 *
 * Arguments are explicit rather than read from `process` so the mapping can
 * be tested for every combination on one machine.
 */
export function resolvePlatformKey(
  platform: string,
  arch: string,
): LocalSttPlatformKey | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64'
    if (arch === 'x64') return 'darwin-x64'
    return null
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64'
    if (arch === 'arm64') return 'linux-arm64'
    if (arch === 'arm') return 'linux-arm'
    return null
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'win32-x64'
    if (arch === 'arm64') return 'win32-arm64'
    if (arch === 'ia32') return 'win32-ia32'
    return null
  }
  return null
}

// ─── Models ──────────────────────────────────────────────────────────

/**
 * `sha256` is the file content digest, published by Hugging Face for
 * Git-LFS objects. `git-blob-sha1` is the git object id, the only digest
 * the API exposes for files stored as ordinary blobs (the `tokens.txt`
 * vocabularies); it is computed over `blob <byteLength>\0` + content.
 */
export type ArtifactDigest = {
  algorithm: 'sha256' | 'git-blob-sha1'
  value: string
}

export type ModelFile = {
  /** Name to write inside the model directory. */
  name: string
  url: string
  digest: ArtifactDigest
  bytes: number
}

export type LocalSttModelId =
  | 'sense-voice'
  | 'paraformer-zh-small'
  | 'whisper-tiny'

/**
 * Which family of `sherpa-onnx-offline` flags the model is loaded with.
 * The three families take completely different arguments; see
 * buildTranscribeArgs in transcribe.ts.
 */
export type LocalSttModelKind = 'sense-voice' | 'paraformer' | 'whisper'

export type LocalSttModel = {
  id: LocalSttModelId
  kind: LocalSttModelKind
  /** Human-facing name, shown by `/voice` and in the docs table. */
  label: string
  /** Languages the model was trained on, for the picker text. */
  languages: string
  /** Total download size in bytes, summed from `files`. */
  bytes: number
  files: ModelFile[]
}

const HF = 'https://huggingface.co'

function hfUrl(repo: string, file: string): string {
  return `${HF}/${repo}/resolve/main/${file}`
}

const SENSE_VOICE_REPO =
  'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09'
const PARAFORMER_REPO = 'csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09'
const WHISPER_TINY_REPO = 'csukuangfj/sherpa-onnx-whisper-tiny'

export const LOCAL_STT_MODELS: Readonly<
  Record<LocalSttModelId, LocalSttModel>
> = {
  // Default. Non-autoregressive encoder-only CTC model, so it decodes an
  // utterance in a single forward pass — far cheaper than Whisper's
  // token-by-token decoder at comparable Chinese accuracy, which is what
  // makes a 237MB int8 file the accuracy/size sweet spot here.
  'sense-voice': {
    id: 'sense-voice',
    kind: 'sense-voice',
    label: 'SenseVoice Small (int8)',
    languages: '中文 / English / 日本語 / 한국어 / 粤语',
    bytes: 237115547 + 315894,
    files: [
      {
        name: 'model.int8.onnx',
        url: hfUrl(SENSE_VOICE_REPO, 'model.int8.onnx'),
        digest: {
          algorithm: 'sha256',
          value:
            '12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d',
        },
        bytes: 237115547,
      },
      {
        name: 'tokens.txt',
        url: hfUrl(SENSE_VOICE_REPO, 'tokens.txt'),
        digest: {
          algorithm: 'git-blob-sha1',
          value: '2cfc92fc2ff26aaa690b7c01fd96b41109413881',
        },
        bytes: 315894,
      },
    ],
  },
  // Smallest useful option: a third of SenseVoice, Mandarin only.
  'paraformer-zh-small': {
    id: 'paraformer-zh-small',
    kind: 'paraformer',
    label: 'Paraformer zh small (int8)',
    languages: '中文',
    bytes: 81828675 + 75352,
    files: [
      {
        name: 'model.int8.onnx',
        url: hfUrl(PARAFORMER_REPO, 'model.int8.onnx'),
        digest: {
          algorithm: 'sha256',
          value:
            '3ef6c19369b912f7caf3cef8e545c5ccd1a33d9d7ec792a46668dc41c4b229ec',
        },
        bytes: 81828675,
      },
      {
        name: 'tokens.txt',
        url: hfUrl(PARAFORMER_REPO, 'tokens.txt'),
        digest: {
          algorithm: 'git-blob-sha1',
          value: 'b93796992f79316b1e10dfa6f30a0a8c0962fe53',
        },
        bytes: 75352,
      },
    ],
  },
  // For dictation in languages neither of the above covers. Whisper tiny is
  // markedly less accurate than SenseVoice on Chinese and English — it is
  // here for coverage of the other ~90 languages, not as an upgrade.
  'whisper-tiny': {
    id: 'whisper-tiny',
    kind: 'whisper',
    label: 'Whisper tiny (int8)',
    languages: '99 languages, lower accuracy',
    bytes: 12937772 + 89855401 + 816730,
    files: [
      {
        name: 'tiny-encoder.int8.onnx',
        url: hfUrl(WHISPER_TINY_REPO, 'tiny-encoder.int8.onnx'),
        digest: {
          algorithm: 'sha256',
          value:
            'd24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434',
        },
        bytes: 12937772,
      },
      {
        name: 'tiny-decoder.int8.onnx',
        url: hfUrl(WHISPER_TINY_REPO, 'tiny-decoder.int8.onnx'),
        digest: {
          algorithm: 'sha256',
          value:
            'd2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925',
        },
        bytes: 89855401,
      },
      {
        name: 'tiny-tokens.txt',
        url: hfUrl(WHISPER_TINY_REPO, 'tiny-tokens.txt'),
        digest: {
          algorithm: 'git-blob-sha1',
          value: 'a4edf0b719c10d28cd83f8c294449f99ff5d5dc0',
        },
        bytes: 816730,
      },
    ],
  },
}

export const DEFAULT_LOCAL_STT_MODEL_ID: LocalSttModelId = 'sense-voice'

export function isLocalSttModelId(value: unknown): value is LocalSttModelId {
  return typeof value === 'string' && value in LOCAL_STT_MODELS
}

export function resolveLocalSttModel(id: string | undefined): LocalSttModel {
  return isLocalSttModelId(id)
    ? LOCAL_STT_MODELS[id]
    : LOCAL_STT_MODELS[DEFAULT_LOCAL_STT_MODEL_ID]
}

/** Format a byte count the way the install messages quote sizes. */
export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}
