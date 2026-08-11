/**
 * Lazy, verified installation of the local speech-to-text artifacts.
 *
 * Nothing here ships in the npm tarball. The published package is ~6.3MB
 * packed and every byte added to it is paid for by users who never touch
 * voice mode, so the runtime (~18-32MB compressed, one archive) and the
 * model (82-237MB, user-selectable) are fetched on first use and cached
 * under `occConfigPath('stt', ...)` — never `~/.claude`, never a bare
 * homedir join. After the first setup the backend is fully offline.
 *
 * Every downloaded byte is verified against a digest pinned in catalog.ts
 * before it reaches a durable path, and the executable bit is only set on a
 * file that passed. A staging directory plus a rename gives an all-or-
 * nothing install: an aborted download leaves no half-populated cache that
 * a later run would mistake for a working one.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { occConfigPath } from '../../config/paths.js'
import { RM_RECURSIVE } from '../../utils/filesystem/rmOptions.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import { toError } from '../../utils/runtime/errors.js'
import { bunzip2 } from './bzip2.js'
import {
  formatMegabytes,
  type LocalSttModel,
  type LocalSttPlatformKey,
  RUNTIME_ARTIFACTS,
  resolvePlatformKey,
  SHERPA_ONNX_VERSION,
} from './catalog.js'
import { verifyDigest, sha256Hex } from './digest.js'
import { readTar, type TarEntry } from './tar.js'

/** Downloads a URL into memory. Injected so tests never touch the network. */
export type DownloadFn = (
  url: string,
  onProgress?: (receivedBytes: number) => void,
) => Promise<Buffer>

// ─── Cache layout ────────────────────────────────────────────────────

/** Root of everything this backend caches. */
export function localSttRoot(): string {
  return occConfigPath('stt')
}

export function runtimeDir(platformKey: LocalSttPlatformKey): string {
  return join(
    localSttRoot(),
    'runtime',
    `sherpa-onnx-${SHERPA_ONNX_VERSION}-${platformKey}`,
  )
}

export function modelDir(modelId: string): string {
  return join(localSttRoot(), 'models', modelId)
}

/**
 * Written only after a directory is fully populated and verified. Its
 * presence — not the presence of the payload files — is what the readiness
 * checks trust.
 */
const MARKER_NAME = '.occ-install.json'

type InstallMarker = {
  version: string
  digest: string
  /** Executable path relative to the directory, POSIX separators. */
  executable: string
}

function readMarker(dir: string): InstallMarker | null {
  const path = join(dir, MARKER_NAME)
  if (!existsSync(path)) return null
  try {
    // Sync + tiny: this sits on the voice keypress path, and a 200-byte
    // read is cheaper than the promise machinery around it.
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as InstallMarker).version === 'string'
    ) {
      return parsed as InstallMarker
    }
  } catch {
    // A corrupt marker reads as "not installed"; the install path rebuilds
    // the directory from scratch rather than trusting half of it.
  }
  return null
}

// ─── Readiness ───────────────────────────────────────────────────────

/**
 * Absolute path to the recognizer executable, or null when the runtime is
 * not installed for this platform.
 */
export function installedExecutablePath(
  platformKey: LocalSttPlatformKey,
): string | null {
  const dir = runtimeDir(platformKey)
  const marker = readMarker(dir)
  if (!marker?.executable) return null
  const exe = join(dir, ...marker.executable.split('/'))
  return existsSync(exe) ? exe : null
}

export function isModelInstalled(model: LocalSttModel): boolean {
  const dir = modelDir(model.id)
  if (!readMarker(dir)) return false
  return model.files.every(file => {
    try {
      return statSync(join(dir, file.name)).size === file.bytes
    } catch {
      return false
    }
  })
}

// ─── Download ────────────────────────────────────────────────────────

/**
 * Default downloader. axios is imported lazily — it drags in a large
 * adapter chain, and voice mode is off in most sessions.
 */
const downloadToBuffer: DownloadFn = async (url, onProgress) => {
  const { default: axios } = await import('axios')
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 60 * 60_000,
    maxContentLength: 2 * 1024 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024 * 1024,
    onDownloadProgress: event => {
      onProgress?.(event.loaded)
    },
  })
  return Buffer.from(response.data)
}

// ─── Progress ────────────────────────────────────────────────────────

type InstallPhase =
  | 'idle'
  | 'runtime'
  | 'model'
  | 'installing'
  | 'ready'
  | 'failed'

type InstallProgress = {
  phase: InstallPhase
  /** Bytes fetched so far across every artifact in this run. */
  receivedBytes: number
  /** Total bytes this run will fetch. */
  totalBytes: number
  /** Set when phase is 'failed'. */
  error?: string
}

let progress: InstallProgress = {
  phase: 'idle',
  receivedBytes: 0,
  totalBytes: 0,
}

/** Snapshot of the current (or last) install run. */
export function getInstallProgress(): InstallProgress {
  return { ...progress }
}

export function describeInstallProgress(): string {
  const snapshot = progress
  if (snapshot.phase === 'failed') {
    return `安装失败：${snapshot.error ?? 'unknown error'}`
  }
  if (snapshot.phase === 'ready') return '已就绪'
  if (snapshot.phase === 'idle') return '尚未开始'
  if (snapshot.phase === 'installing') return '正在解压安装…'
  const percent =
    snapshot.totalBytes > 0
      ? Math.min(
          99,
          Math.floor((snapshot.receivedBytes / snapshot.totalBytes) * 100),
        )
      : 0
  const what = snapshot.phase === 'runtime' ? '识别引擎' : '语音模型'
  return `正在下载${what} ${percent}%（${formatMegabytes(snapshot.receivedBytes)} / ${formatMegabytes(snapshot.totalBytes)}）`
}

let inFlight: Promise<void> | null = null

/** Test seam: drop the memoized in-flight install and reset progress. */
export function _resetInstallStateForTesting(): void {
  inFlight = null
  progress = { phase: 'idle', receivedBytes: 0, totalBytes: 0 }
}

// ─── Install ─────────────────────────────────────────────────────────

/**
 * Thrown when the current platform/arch has no prebuilt artifact. Carries a
 * message naming the platform and what to do about it — a silent failure is
 * what made the existing voice backends look broken.
 */
export class UnsupportedPlatformError extends Error {
  constructor(platform: string, arch: string) {
    super(
      `本地语音识别没有 ${platform}/${arch} 的预编译文件。` +
        '已发布的组合为 macOS x64/arm64、Linux x64/arm64/armv7、Windows x64/arm64/x86。' +
        '在其它平台上可改用 /voice anthropic（需要 Claude.ai 登录），' +
        `或自行编译 sherpa-onnx v${SHERPA_ONNX_VERSION} 并把 sherpa-onnx-offline ` +
        '放进 OCC_LOCAL_STT_BINARY 指向的路径。',
    )
    this.name = 'UnsupportedPlatformError'
  }
}

function currentPlatformKeyOrThrow(): LocalSttPlatformKey {
  const key = resolvePlatformKey(process.platform, process.arch)
  if (!key) throw new UnsupportedPlatformError(process.platform, process.arch)
  return key
}

type StagedFile = { name: string; data: Uint8Array; mode?: number }

async function writeVerifiedFiles(
  targetDir: string,
  entries: StagedFile[],
  marker: InstallMarker,
): Promise<void> {
  const staging = `${targetDir}.tmp-${randomBytes(6).toString('hex')}`
  try {
    for (const entry of entries) {
      const path = join(staging, ...entry.name.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, entry.data)
      if (entry.mode !== undefined) await chmod(path, entry.mode)
    }
    await writeFile(
      join(staging, MARKER_NAME),
      JSON.stringify(marker, null, 2),
      'utf8',
    )
    await mkdir(dirname(targetDir), { recursive: true })
    // Windows cannot rename onto an existing directory, and a stale
    // half-install must not survive a reinstall on any platform.
    await rm(targetDir, RM_RECURSIVE)
    await rename(staging, targetDir)
  } finally {
    await rm(staging, RM_RECURSIVE).catch(() => {})
  }
}

/**
 * The upstream archives wrap everything in a single versioned directory.
 * Strip it so the cache path does not repeat the version twice, but only
 * when every entry really does share that prefix.
 */
export function stripArchiveRoot(names: string[]): string {
  if (names.length === 0) return ''
  const first = names[0]!.split('/')[0]!
  // The archive also contains an entry for the root directory itself, so
  // "shares the prefix" has to accept the bare name as well as `name/`.
  const shared = names.every(
    name => name === first || name.startsWith(`${first}/`),
  )
  return shared ? `${first}/` : ''
}

const EXECUTABLE_RE = /^bin\/sherpa-onnx-offline(\.exe)?$/
const SHARED_LIBRARY_RE = /\.(dylib|dll)$|\.so(\.\d+)*$/i

/**
 * Which archive members are worth keeping. The release archives carry ~40
 * command-line tools; occ runs exactly one, and the rest would triple the
 * on-disk footprint for nothing. Shared libraries are kept wherever they
 * sit, with their relative paths intact, because the executable resolves
 * them through a relative rpath (`@loader_path/../lib` on macOS, `$ORIGIN`
 * on Linux) or same-directory DLL search on Windows.
 */
export function isWantedRuntimeEntry(relativeName: string): boolean {
  return (
    EXECUTABLE_RE.test(relativeName) || SHARED_LIBRARY_RE.test(relativeName)
  )
}

function isSafeRelativePath(name: string): boolean {
  if (name === '' || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    return false
  }
  return !name.split('/').includes('..')
}

/**
 * Turn tar entries into files to write. Symlinks are materialised as
 * copies: real symlinks need Developer Mode or an elevated process on
 * Windows, and `lib/libonnxruntime.dylib -> libonnxruntime.1.17.1.dylib`
 * must resolve or the executable will not load.
 */
export function selectRuntimeFiles(entries: TarEntry[]): {
  files: StagedFile[]
  executable: string | null
} {
  const prefix = stripArchiveRoot(entries.map(entry => entry.name))
  const byName = new Map<string, Uint8Array>()
  const order: string[] = []
  const links: { name: string; target: string }[] = []

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue
    const relative = entry.name.slice(prefix.length)
    if (!isSafeRelativePath(relative) || !isWantedRuntimeEntry(relative)) {
      continue
    }
    if (entry.type === 'file') {
      byName.set(relative, entry.data)
      order.push(relative)
    } else if (entry.type === 'symlink' || entry.type === 'hardlink') {
      links.push({ name: relative, target: entry.linkTarget })
    }
  }

  for (const link of links) {
    // Symlink targets are relative to the link's own directory; hardlink
    // targets are archive-relative.
    const dir = link.name.includes('/')
      ? link.name.slice(0, link.name.lastIndexOf('/') + 1)
      : ''
    const candidates = [
      `${dir}${link.target}`,
      link.target.startsWith(prefix)
        ? link.target.slice(prefix.length)
        : link.target,
    ]
    const resolved = candidates.find(candidate => byName.has(candidate))
    if (resolved) {
      byName.set(link.name, byName.get(resolved)!)
      order.push(link.name)
    }
  }

  const executable = order.find(name => EXECUTABLE_RE.test(name)) ?? null
  return {
    files: order.map(name => ({
      name,
      data: byName.get(name)!,
      mode: name === executable ? 0o755 : undefined,
    })),
    executable,
  }
}

async function installRuntime(
  platformKey: LocalSttPlatformKey,
  download: DownloadFn,
  onBytes: (received: number) => void,
): Promise<void> {
  const artifact = RUNTIME_ARTIFACTS[platformKey]
  logForDebugging(`[local-stt] downloading runtime ${artifact.fileName}`)
  const archive = await download(artifact.url, onBytes)

  const actual = sha256Hex(archive)
  if (actual !== artifact.sha256) {
    throw new Error(
      `${artifact.fileName}: sha256 mismatch — expected ${artifact.sha256}, got ${actual}. ` +
        'The download was discarded; nothing was executed.',
    )
  }

  progress = { ...progress, phase: 'installing' }
  const { files, executable } = selectRuntimeFiles(readTar(bunzip2(archive)))
  if (!executable) {
    throw new Error(
      `${artifact.fileName} does not contain bin/sherpa-onnx-offline. ` +
        'The upstream archive layout changed; occ needs an update.',
    )
  }

  await writeVerifiedFiles(runtimeDir(platformKey), files, {
    version: SHERPA_ONNX_VERSION,
    digest: artifact.sha256,
    executable,
  })
  logForDebugging(`[local-stt] runtime installed at ${runtimeDir(platformKey)}`)
}

async function installModel(
  model: LocalSttModel,
  download: DownloadFn,
  onBytes: (received: number) => void,
): Promise<void> {
  const files: StagedFile[] = []
  let completed = 0
  for (const file of model.files) {
    logForDebugging(`[local-stt] downloading ${model.id}/${file.name}`)
    const base = completed
    const data = await download(file.url, received => onBytes(base + received))
    verifyDigest(`${model.id}/${file.name}`, data, file.digest)
    files.push({ name: file.name, data })
    completed += file.bytes
    onBytes(completed)
  }
  progress = { ...progress, phase: 'installing' }
  await writeVerifiedFiles(modelDir(model.id), files, {
    version: model.id,
    digest: model.files.map(file => file.digest.value).join(','),
    executable: '',
  })
  logForDebugging(`[local-stt] model installed at ${modelDir(model.id)}`)
}

/**
 * Fetch whatever is missing for `model` on this platform. Concurrent calls
 * join the same run. Resolves once the backend is usable; rejects with an
 * actionable message otherwise.
 */
export function ensureLocalSttInstalled(
  model: LocalSttModel,
  download: DownloadFn = downloadToBuffer,
): Promise<void> {
  inFlight ??= runInstall(model, download).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runInstall(
  model: LocalSttModel,
  download: DownloadFn,
): Promise<void> {
  // A user-supplied binary makes the runtime download unnecessary, and is
  // the documented way to run on a platform with no published archive —
  // so consult it before deciding the platform is unsupported.
  const override = overrideExecutable()
  const platformKey = override
    ? resolvePlatformKey(process.platform, process.arch)
    : currentPlatformKeyOrThrow()
  const needRuntime =
    !override &&
    platformKey !== null &&
    installedExecutablePath(platformKey) === null
  const needModel = !isModelInstalled(model)
  if (!needRuntime && !needModel) {
    progress = { phase: 'ready', receivedBytes: 0, totalBytes: 0 }
    return
  }

  const runtimeBytes =
    needRuntime && platformKey ? RUNTIME_ARTIFACTS[platformKey].bytes : 0
  const modelBytes = needModel ? model.bytes : 0
  progress = {
    phase: needRuntime ? 'runtime' : 'model',
    receivedBytes: 0,
    totalBytes: runtimeBytes + modelBytes,
  }

  try {
    if (needRuntime && platformKey) {
      await installRuntime(platformKey, download, received => {
        progress = { ...progress, phase: 'runtime', receivedBytes: received }
      })
    }
    if (needModel) {
      await installModel(model, download, received => {
        progress = {
          ...progress,
          phase: 'model',
          receivedBytes: runtimeBytes + received,
        }
      })
    }
    progress = {
      phase: 'ready',
      receivedBytes: runtimeBytes + modelBytes,
      totalBytes: runtimeBytes + modelBytes,
    }
  } catch (error) {
    const err = toError(error)
    progress = { ...progress, phase: 'failed', error: err.message }
    throw err
  }
}

// ─── Readiness for the hot path ──────────────────────────────────────

type LocalSttReadiness =
  | { ready: true; executable: string; modelDir: string }
  | { ready: false; reason: string }

/**
 * Escape hatch for platforms with no published archive, and for users who
 * would rather point at a sherpa-onnx they already have.
 */
function overrideExecutable(): string | null {
  const configured = process.env.OCC_LOCAL_STT_BINARY?.trim()
  return configured && existsSync(configured) ? configured : null
}

/**
 * Synchronous check used by the voice keypress path and by `/voice`.
 * Never downloads; only reports what is on disk and, when something is
 * missing, exactly what and how big.
 */
export function checkLocalSttReadiness(
  model: LocalSttModel,
): LocalSttReadiness {
  const platformKey = resolvePlatformKey(process.platform, process.arch)
  const override = overrideExecutable()
  if (!platformKey && !override) {
    return {
      ready: false,
      reason: new UnsupportedPlatformError(process.platform, process.arch)
        .message,
    }
  }
  const executable =
    override ?? (platformKey ? installedExecutablePath(platformKey) : null)
  const modelReady = isModelInstalled(model)
  if (executable && modelReady) {
    return { ready: true, executable, modelDir: modelDir(model.id) }
  }
  if (progress.phase === 'runtime' || progress.phase === 'model') {
    return { ready: false, reason: describeInstallProgress() }
  }
  if (progress.phase === 'failed') {
    return {
      ready: false,
      reason: `本地语音识别安装失败：${progress.error ?? 'unknown error'}。运行 /voice local 重试。`,
    }
  }
  const missing: string[] = []
  if (!executable && platformKey) {
    missing.push(
      `识别引擎 ${formatMegabytes(RUNTIME_ARTIFACTS[platformKey].bytes)}`,
    )
  }
  if (!modelReady) {
    missing.push(`模型 ${model.label} ${formatMegabytes(model.bytes)}`)
  }
  return {
    ready: false,
    reason: `本地语音识别尚未安装（缺少 ${missing.join('、')}）。运行 /voice local 开始下载。`,
  }
}

/**
 * Best-effort smoke test that the extracted executable actually launches on
 * this machine — an archive can extract cleanly and still fail to run
 * (missing glibc symbols on an old distro, a macOS binary whose signature
 * the kernel rejects). Cheap: `--help` exits without loading a model.
 * Returns the failure text so callers can surface it verbatim.
 */
function probeExecutable(executable: string): string | null {
  const result = spawnSync(executable, ['--help'], {
    stdio: 'ignore',
    timeout: 15_000,
  })
  return result.error ? result.error.message : null
}
