/**
 * Guards on the pinned artifact table and on digest verification.
 *
 * The table is hand-maintained: every entry was copied from a metadata API
 * (GitHub's per-asset `digest`, Hugging Face's `lfs.oid` / git object id)
 * and a typo in any of it means either a download that always fails or,
 * worse, a digest that no longer corresponds to the file it guards.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LOCAL_STT_MODEL_ID,
  formatMegabytes,
  isLocalSttModelId,
  LOCAL_STT_MODELS,
  type LocalSttPlatformKey,
  resolveLocalSttModel,
  resolvePlatformKey,
  RUNTIME_ARTIFACTS,
  SHERPA_ONNX_VERSION,
} from '../catalog.js'
import {
  computeDigest,
  DigestMismatchError,
  gitBlobSha1,
  sha256Hex,
  verifyDigest,
} from '../digest.js'

describe('resolvePlatformKey', () => {
  // The whole point of choosing sherpa-onnx over whisper.cpp was that all
  // six of these exist upstream. If one loses its artifact the mapping
  // must go to null (actionable error), never to a neighbouring arch.
  const supported: [string, string, LocalSttPlatformKey][] = [
    ['darwin', 'arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['linux', 'arm', 'linux-arm'],
    ['win32', 'x64', 'win32-x64'],
    ['win32', 'arm64', 'win32-arm64'],
    ['win32', 'ia32', 'win32-ia32'],
  ]

  for (const [platform, arch, expected] of supported) {
    test(`${platform}/${arch} resolves to ${expected}`, () => {
      expect(resolvePlatformKey(platform, arch)).toBe(expected)
      expect(RUNTIME_ARTIFACTS[expected]).toBeDefined()
    })
  }

  test('returns null for combinations upstream does not build', () => {
    expect(resolvePlatformKey('darwin', 'ppc64')).toBeNull()
    expect(resolvePlatformKey('linux', 'riscv64')).toBeNull()
    expect(resolvePlatformKey('freebsd', 'x64')).toBeNull()
    expect(resolvePlatformKey('android', 'arm64')).toBeNull()
  })
})

describe('RUNTIME_ARTIFACTS', () => {
  for (const [key, artifact] of Object.entries(RUNTIME_ARTIFACTS)) {
    test(`${key} is pinned by version, digest and size`, () => {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(artifact.bytes).toBeGreaterThan(1_000_000)
      expect(artifact.url).toContain(`/v${SHERPA_ONNX_VERSION}/`)
      expect(artifact.url.endsWith(artifact.fileName)).toBe(true)
      expect(artifact.fileName).toContain(SHERPA_ONNX_VERSION)
    })
  }

  test('Windows uses static-CRT builds so no VC++ redistributable is needed', () => {
    for (const key of ['win32-x64', 'win32-arm64', 'win32-ia32'] as const) {
      expect(RUNTIME_ARTIFACTS[key].fileName).toContain('-MT-')
    }
  })

  test('every archive is served over https', () => {
    for (const artifact of Object.values(RUNTIME_ARTIFACTS)) {
      expect(artifact.url.startsWith('https://')).toBe(true)
    }
  })
})

describe('LOCAL_STT_MODELS', () => {
  test('the default is the multilingual model, not a Chinese-only one', () => {
    expect(DEFAULT_LOCAL_STT_MODEL_ID).toBe('sense-voice')
    expect(LOCAL_STT_MODELS[DEFAULT_LOCAL_STT_MODEL_ID].languages).toContain(
      'English',
    )
  })

  for (const [id, model] of Object.entries(LOCAL_STT_MODELS)) {
    test(`${id} declares files, digests and a total size that agree`, () => {
      expect(model.id).toBe(id as never)
      expect(model.files.length).toBeGreaterThan(0)
      const summed = model.files.reduce((total, file) => total + file.bytes, 0)
      expect(model.bytes).toBe(summed)
      for (const file of model.files) {
        expect(file.url.startsWith('https://huggingface.co/')).toBe(true)
        expect(file.bytes).toBeGreaterThan(0)
        if (file.digest.algorithm === 'sha256') {
          expect(file.digest.value).toMatch(/^[0-9a-f]{64}$/)
        } else {
          expect(file.digest.algorithm).toBe('git-blob-sha1')
          expect(file.digest.value).toMatch(/^[0-9a-f]{40}$/)
        }
      }
    })
  }

  test('every model ships the token file its flags will point at', () => {
    for (const model of Object.values(LOCAL_STT_MODELS)) {
      const tokens = model.kind === 'whisper' ? 'tiny-tokens.txt' : 'tokens.txt'
      expect(model.files.some(file => file.name === tokens)).toBe(true)
    }
  })

  test('unknown ids fall back to the default rather than throwing', () => {
    expect(isLocalSttModelId('sense-voice')).toBe(true)
    expect(isLocalSttModelId('ggml-large-v3')).toBe(false)
    expect(resolveLocalSttModel(undefined).id).toBe(DEFAULT_LOCAL_STT_MODEL_ID)
    expect(resolveLocalSttModel('nonsense').id).toBe(DEFAULT_LOCAL_STT_MODEL_ID)
    expect(resolveLocalSttModel('paraformer-zh-small').id).toBe(
      'paraformer-zh-small',
    )
  })

  test('sizes are reported the way the install message quotes them', () => {
    expect(formatMegabytes(LOCAL_STT_MODELS['sense-voice'].bytes)).toBe(
      '226 MB',
    )
    expect(formatMegabytes(LOCAL_STT_MODELS['paraformer-zh-small'].bytes)).toBe(
      '78 MB',
    )
  })
})

describe('digest verification', () => {
  const hello = Buffer.from('hello world\n')

  test('sha256 matches the reference value', () => {
    expect(sha256Hex(hello)).toBe(
      'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447',
    )
  })

  test('git blob sha1 matches `git hash-object`', () => {
    // git hash-object --stdin <<< 'hello world'
    expect(gitBlobSha1(hello)).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad')
    // git hash-object -t blob /dev/null
    expect(gitBlobSha1(new Uint8Array(0))).toBe(
      'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    )
  })

  test('computeDigest dispatches on the declared algorithm', () => {
    expect(computeDigest(hello, 'sha256')).toBe(sha256Hex(hello))
    expect(computeDigest(hello, 'git-blob-sha1')).toBe(gitBlobSha1(hello))
  })

  test('verifyDigest accepts a match and rejects a mismatch', () => {
    expect(() =>
      verifyDigest('model', hello, {
        algorithm: 'sha256',
        value: sha256Hex(hello),
      }),
    ).not.toThrow()

    expect(() =>
      verifyDigest('model', Buffer.from('tampered'), {
        algorithm: 'sha256',
        value: sha256Hex(hello),
      }),
    ).toThrow(DigestMismatchError)
  })

  test('a mismatch says the download was discarded, not merely that it failed', () => {
    try {
      verifyDigest('sense-voice/model.int8.onnx', Buffer.from('x'), {
        algorithm: 'sha256',
        value: sha256Hex(hello),
      })
      throw new Error('expected verifyDigest to throw')
    } catch (error) {
      expect(String(error)).toContain('sense-voice/model.int8.onnx')
      expect(String(error)).toContain('nothing was executed')
    }
  })
})
