/**
 * Install-path regressions.
 *
 * Everything runs against a throwaway OCC_CONFIG_DIR and an injected
 * downloader — no network, and nothing is written near the user's real
 * `~/.occ`. The model is injected too, which is what makes the digest gate
 * testable at all: the shipped catalog pins a 226MB file whose bytes
 * cannot be fabricated in a unit test.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalSttModel } from '../catalog.js'
import { RUNTIME_ARTIFACTS, resolvePlatformKey } from '../catalog.js'
import { sha256Hex } from '../digest.js'
import {
  _resetInstallStateForTesting,
  checkLocalSttReadiness,
  type DownloadFn,
  ensureLocalSttInstalled,
  getInstallProgress,
  installedExecutablePath,
  isModelInstalled,
  localSttRoot,
  modelDir,
  runtimeDir,
  UnsupportedPlatformError,
} from '../install.js'

const MODEL_BYTES = Buffer.from('pretend this is 226MB of int8 weights')
const TOKENS_BYTES = Buffer.from('▁hello\n▁world\n')

const TEST_MODEL: LocalSttModel = {
  id: 'occ-test-model',
  kind: 'sense-voice',
  label: 'Test model',
  languages: 'test',
  bytes: MODEL_BYTES.byteLength + TOKENS_BYTES.byteLength,
  files: [
    {
      name: 'model.int8.onnx',
      url: 'https://example.invalid/model.int8.onnx',
      digest: { algorithm: 'sha256', value: sha256Hex(MODEL_BYTES) },
      bytes: MODEL_BYTES.byteLength,
    },
    {
      name: 'tokens.txt',
      url: 'https://example.invalid/tokens.txt',
      digest: { algorithm: 'sha256', value: sha256Hex(TOKENS_BYTES) },
      bytes: TOKENS_BYTES.byteLength,
    },
  ],
} as unknown as LocalSttModel

function servingModelFiles(): DownloadFn {
  return url =>
    Promise.resolve(url.endsWith('tokens.txt') ? TOKENS_BYTES : MODEL_BYTES)
}

/** Pretend the runtime is already installed so tests can isolate a phase. */
function fakeRuntimeInstall(): string {
  const key = resolvePlatformKey(process.platform, process.arch)!
  const dir = runtimeDir(key)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'sherpa-onnx-offline'), '#!/bin/sh\n')
  writeFileSync(
    join(dir, '.occ-install.json'),
    JSON.stringify({
      version: 'test',
      digest: 'test',
      executable: 'bin/sherpa-onnx-offline',
    }),
  )
  return dir
}

let previousConfigDir: string | undefined
let previousLegacyDir: string | undefined
let tempRoot: string

beforeAll(() => {
  previousConfigDir = process.env.OCC_CONFIG_DIR
  previousLegacyDir = process.env.CLAUDE_CONFIG_DIR
  tempRoot = mkdtempSync(join(tmpdir(), 'occ-localstt-'))
  process.env.OCC_CONFIG_DIR = tempRoot
  delete process.env.CLAUDE_CONFIG_DIR
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = previousConfigDir
  if (previousLegacyDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = previousLegacyDir
  }
  rmSync(tempRoot, { recursive: true, force: true })
})

beforeEach(() => {
  _resetInstallStateForTesting()
  rmSync(localSttRoot(), { recursive: true, force: true })
})

describe('cache location', () => {
  test('everything lives under the occ config dir, never ~/.claude', () => {
    expect(localSttRoot().startsWith(tempRoot)).toBe(true)
    expect(modelDir('sense-voice').startsWith(tempRoot)).toBe(true)
    expect(runtimeDir('darwin-arm64').startsWith(tempRoot)).toBe(true)
    expect(runtimeDir('darwin-arm64')).not.toContain('.claude')
  })
})

describe('checkLocalSttReadiness', () => {
  test('names what is missing, how big it is, and what to run', () => {
    const readiness = checkLocalSttReadiness(TEST_MODEL)
    expect(readiness.ready).toBe(false)
    if (readiness.ready) throw new Error('unreachable')
    expect(readiness.reason).toContain('识别引擎')
    expect(readiness.reason).toContain('Test model')
    expect(readiness.reason).toContain('/voice local')
  })

  test('reports ready once both halves are on disk', async () => {
    fakeRuntimeInstall()
    await ensureLocalSttInstalled(TEST_MODEL, servingModelFiles())
    const readiness = checkLocalSttReadiness(TEST_MODEL)
    expect(readiness.ready).toBe(true)
    if (!readiness.ready) throw new Error('unreachable')
    expect(readiness.executable).toContain('sherpa-onnx-offline')
    expect(readiness.modelDir).toBe(modelDir(TEST_MODEL.id))
  })

  test('OCC_LOCAL_STT_BINARY replaces the managed runtime download', async () => {
    const external = join(tempRoot, 'my-sherpa')
    writeFileSync(external, '#!/bin/sh\n')
    process.env.OCC_LOCAL_STT_BINARY = external
    try {
      // No managed runtime on disk, and the injected downloader would fail
      // the runtime digest check if it were asked for one.
      await ensureLocalSttInstalled(TEST_MODEL, servingModelFiles())
      const readiness = checkLocalSttReadiness(TEST_MODEL)
      expect(readiness.ready).toBe(true)
      if (!readiness.ready) throw new Error('unreachable')
      expect(readiness.executable).toBe(external)
    } finally {
      delete process.env.OCC_LOCAL_STT_BINARY
    }
  })
})

describe('ensureLocalSttInstalled', () => {
  test('writes model files and marks the directory installed', async () => {
    fakeRuntimeInstall()
    await ensureLocalSttInstalled(TEST_MODEL, servingModelFiles())
    expect(isModelInstalled(TEST_MODEL)).toBe(true)
    expect(getInstallProgress().phase).toBe('ready')
  })

  test('a model whose digest does not match is discarded, not installed', async () => {
    fakeRuntimeInstall()
    const tampered: DownloadFn = url =>
      Promise.resolve(
        url.endsWith('tokens.txt')
          ? TOKENS_BYTES
          : Buffer.from('a different file entirely'),
      )

    await expect(ensureLocalSttInstalled(TEST_MODEL, tampered)).rejects.toThrow(
      /sha256 mismatch/,
    )
    expect(isModelInstalled(TEST_MODEL)).toBe(false)
    expect(getInstallProgress().phase).toBe('failed')
  })

  test('a runtime archive whose digest does not match never reaches disk', async () => {
    const key = resolvePlatformKey(process.platform, process.arch)!
    const garbage: DownloadFn = () =>
      Promise.resolve(Buffer.from('not a tarball'))

    await expect(ensureLocalSttInstalled(TEST_MODEL, garbage)).rejects.toThrow(
      /sha256 mismatch/,
    )
    expect(installedExecutablePath(key)).toBeNull()
    // The message must name the artifact and say nothing was executed.
    try {
      await ensureLocalSttInstalled(TEST_MODEL, garbage)
    } catch (error) {
      expect(String(error)).toContain(RUNTIME_ARTIFACTS[key].fileName)
      expect(String(error)).toContain('nothing was executed')
    }
  })

  test('concurrent callers join one run instead of downloading twice', async () => {
    fakeRuntimeInstall()
    let calls = 0
    const counting: DownloadFn = url => {
      calls++
      return Promise.resolve(
        url.endsWith('tokens.txt') ? TOKENS_BYTES : MODEL_BYTES,
      )
    }
    await Promise.all([
      ensureLocalSttInstalled(TEST_MODEL, counting),
      ensureLocalSttInstalled(TEST_MODEL, counting),
      ensureLocalSttInstalled(TEST_MODEL, counting),
    ])
    expect(calls).toBe(TEST_MODEL.files.length)
  })

  test('an already-complete install downloads nothing', async () => {
    fakeRuntimeInstall()
    await ensureLocalSttInstalled(TEST_MODEL, servingModelFiles())
    _resetInstallStateForTesting()
    let calls = 0
    await ensureLocalSttInstalled(TEST_MODEL, () => {
      calls++
      return Promise.resolve(Buffer.alloc(0))
    })
    expect(calls).toBe(0)
  })

  test('progress reports bytes against a known total while downloading', async () => {
    fakeRuntimeInstall()
    const seen: number[] = []
    await ensureLocalSttInstalled(TEST_MODEL, (url, onProgress) => {
      onProgress?.(1)
      seen.push(getInstallProgress().receivedBytes)
      return Promise.resolve(
        url.endsWith('tokens.txt') ? TOKENS_BYTES : MODEL_BYTES,
      )
    })
    expect(seen.length).toBe(2)
    expect(getInstallProgress().totalBytes).toBe(TEST_MODEL.bytes)
  })
})

describe('UnsupportedPlatformError', () => {
  test('names the platform and offers a way forward', () => {
    const error = new UnsupportedPlatformError('sunos', 'sparc')
    expect(error.message).toContain('sunos/sparc')
    expect(error.message).toContain('/voice anthropic')
    expect(error.message).toContain('OCC_LOCAL_STT_BINARY')
  })
})
