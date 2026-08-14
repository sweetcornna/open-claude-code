import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { ArtifactTool } from '../ArtifactTool.js'

const TEST_DIR = join(tmpdir(), 'artifact-tool-test')
const TEST_FILE = join(TEST_DIR, 'report.html')
const MD_FILE = join(TEST_DIR, 'report.md')
const TXT_FILE = join(TEST_DIR, 'notes.txt')
const MISSING_FILE = join(TEST_DIR, 'does-not-exist.html')
const DIR_AS_FILE = TEST_DIR

const originalFetch = globalThis.fetch

function seedFiles() {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(TEST_FILE, '<h1>test report</h1>', 'utf8')
  writeFileSync(
    MD_FILE,
    '# MD Report\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    'utf8',
  )
  writeFileSync(TXT_FILE, 'plain text content', 'utf8')
}

function mockFetchSuccess(body: object): typeof fetch {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch
}

describe('ArtifactTool.call (worker backend)', () => {
  beforeEach(() => {
    seedFiles()
    // The worker backend is opt-in now; the default is local.
    process.env.OCC_ARTIFACTS_BACKEND = 'worker'
    process.env.CLAUDE_ARTIFACTS_TOKEN = 'test-token'
    process.env.CLAUDE_ARTIFACTS_URL = 'https://example.test'
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
    delete process.env.OCC_ARTIFACTS_BACKEND
    delete process.env.CLAUDE_ARTIFACTS_TOKEN
    delete process.env.CLAUDE_ARTIFACTS_URL
    globalThis.fetch = originalFetch
  })

  test('uploads existing HTML file and returns id/url/expiresAt', async () => {
    globalThis.fetch = mockFetchSuccess({
      id: 'abc123',
      url: 'https://example.test/7d/abc123.html',
      expiresAt: '2026-06-27T10:00:00.000Z',
    })

    const result = await ArtifactTool.call({ file_path: TEST_FILE, ttl: 7 })

    expect(result.data).toMatchObject({
      id: 'abc123',
      url: 'https://example.test/7d/abc123.html',
      expiresAt: '2026-06-27T10:00:00.000Z',
    })
    expect((result.data as { error?: string }).error).toBeUndefined()
  })

  test('passes hash through when overwriting', async () => {
    const fetchMock = mockFetchSuccess({
      id: 'stable-id',
      url: 'https://example.test/7d/stable-id.html',
      expiresAt: '2026-06-27T10:00:00.000Z',
    })
    globalThis.fetch = fetchMock

    await ArtifactTool.call({ file_path: TEST_FILE, hash: 'stable-id', ttl: 7 })

    const calledUrl = (
      fetchMock as unknown as { mock: { calls: [string | URL | Request][] } }
    ).mock.calls[0][0]
    expect(calledUrl.toString()).toContain('hash=stable-id')
  })

  test('returns error when file does not exist (no HTTP call)', async () => {
    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve(new Response('{}'))
    }) as unknown as typeof fetch

    const result = await ArtifactTool.call({ file_path: MISSING_FILE, ttl: 7 })

    expect(fetchCalled).toBe(false)
    expect((result.data as { error?: string }).error).toContain(
      'does not exist',
    )
  })

  test('returns error when path is a directory', async () => {
    const result = await ArtifactTool.call({ file_path: DIR_AS_FILE, ttl: 7 })

    expect((result.data as { error?: string }).error).toContain(
      'not a regular file',
    )
  })

  test('returns error verbatim when backend rejects', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'payload_too_large' }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch

    // Force the size guard to pass by writing a small file but having backend complain.
    const result = await ArtifactTool.call({ file_path: TEST_FILE, ttl: 7 })

    expect((result.data as { error?: string }).error).toContain(
      'payload_too_large',
    )
  })

  test('converts .md file to styled HTML before upload', async () => {
    const fetchMock = mockFetchSuccess({
      id: 'md-id',
      url: 'https://example.test/7d/md-id.html',
      expiresAt: '2026-06-27T10:00:00.000Z',
    })
    globalThis.fetch = fetchMock

    const result = await ArtifactTool.call({ file_path: MD_FILE, ttl: 7 })

    expect(result.data).toMatchObject({ id: 'md-id' })
    expect((result.data as { error?: string }).error).toBeUndefined()

    const calls = (
      fetchMock as unknown as {
        mock: { calls: [string | URL | Request, RequestInit | undefined][] }
      }
    ).mock.calls
    expect(calls.length).toBe(1)
    const body = String(calls[0][1]?.body)
    expect(body.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(body).toContain('<h1>MD Report</h1>')
    expect(body).toContain('<table>')
    expect(body).toContain('<title>MD Report</title>')
    // Content-Type header must remain text/html — the Worker only accepts HTML.
    expect(calls[0][1]?.headers).toMatchObject({ 'Content-Type': 'text/html' })
  })

  test('rejects unsupported extension without calling fetch', async () => {
    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve(new Response('{}'))
    }) as unknown as typeof fetch

    const result = await ArtifactTool.call({ file_path: TXT_FILE, ttl: 7 })

    expect(fetchCalled).toBe(false)
    expect((result.data as { error?: string }).error).toContain(
      'Unsupported file extension',
    )
    expect((result.data as { error?: string }).error).toContain('.md')
  })

  test('fails without a network request when no token is configured', async () => {
    delete process.env.CLAUDE_ARTIFACTS_TOKEN
    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve(new Response('{}'))
    }) as unknown as typeof fetch

    const result = await ArtifactTool.call({ file_path: TEST_FILE, ttl: 7 })

    expect(fetchCalled).toBe(false)
    const error = (result.data as { error?: string }).error ?? ''
    expect(error).toContain('OCC_ARTIFACTS_TOKEN')
    expect(error).toContain('OCC_ARTIFACTS_BACKEND')
  })
})

describe('ArtifactTool.call (default local backend)', () => {
  const savedOcc = process.env.OCC_CONFIG_DIR
  const savedClaude = process.env.CLAUDE_CONFIG_DIR
  const savedBackend = process.env.OCC_ARTIFACTS_BACKEND
  let configDir: string

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), 'occ-artifact-tool-'))
    process.env.OCC_CONFIG_DIR = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.OCC_ARTIFACTS_BACKEND
  })

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true })
    if (savedOcc === undefined) delete process.env.OCC_CONFIG_DIR
    else process.env.OCC_CONFIG_DIR = savedOcc
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaude
    if (savedBackend !== undefined)
      process.env.OCC_ARTIFACTS_BACKEND = savedBackend
  })

  beforeEach(() => {
    seedFiles()
    // Any HTTP traffic at all is a bug for the local backend.
    globalThis.fetch = mock(() => {
      throw new Error('local backend must not make network requests')
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
    globalThis.fetch = originalFetch
  })

  test('writes the converted page under the config dir and returns file://', async () => {
    const result = await ArtifactTool.call({ file_path: MD_FILE, ttl: 7 })
    const data = result.data as {
      id: string
      url: string
      expiresAt: string
      error?: string
    }

    expect(data.error).toBeUndefined()
    expect(data.expiresAt).toBe('')
    expect(data.url.startsWith('file://')).toBe(true)

    const filePath = fileURLToPath(data.url)
    expect(filePath).toBe(join(configDir, 'artifacts', `${data.id}.html`))
    const written = readFileSync(filePath, 'utf8')
    expect(written).toContain('<h1>MD Report</h1>')
    expect(written).toContain('@media (prefers-color-scheme: dark)')
  })

  test('stores .html input byte-for-byte', async () => {
    const result = await ArtifactTool.call({ file_path: TEST_FILE, ttl: 7 })
    const data = result.data as { url: string }

    expect(readFileSync(fileURLToPath(data.url), 'utf8')).toBe(
      '<h1>test report</h1>',
    )
  })

  test('the same hash overwrites in place', async () => {
    const first = await ArtifactTool.call({
      file_path: TEST_FILE,
      hash: 'pinned',
      ttl: 7,
    })
    writeFileSync(TEST_FILE, '<h1>second revision</h1>', 'utf8')
    const second = await ArtifactTool.call({
      file_path: TEST_FILE,
      hash: 'pinned',
      ttl: 7,
    })

    const a = first.data as { id: string; url: string }
    const b = second.data as { id: string; url: string }
    expect(b.id).toBe('pinned')
    expect(b.url).toBe(a.url)
    expect(readFileSync(fileURLToPath(b.url), 'utf8')).toBe(
      '<h1>second revision</h1>',
    )
  })

  test('the tool result tells the model the artifact is local', async () => {
    const result = await ArtifactTool.call({ file_path: TEST_FILE, ttl: 7 })
    const block = ArtifactTool.mapToolResultToToolResultBlockParam!(
      result.data as never,
      'toolu_1',
    )

    expect(String(block.content)).toContain('Artifact saved locally: file://')
    expect(String(block.content)).not.toContain('expires:')
  })
})

describe('getArtifactsToken', () => {
  test('refuses to fall back to the known-stale baked-in token', async () => {
    const savedOcc = process.env.OCC_ARTIFACTS_TOKEN
    const savedClaude = process.env.CLAUDE_ARTIFACTS_TOKEN
    delete process.env.OCC_ARTIFACTS_TOKEN
    delete process.env.CLAUDE_ARTIFACTS_TOKEN
    try {
      const { getArtifactsToken, getConfiguredArtifactsToken } = await import(
        '../config.js'
      )
      expect(getConfiguredArtifactsToken()).toBeUndefined()
      // The whole point: no doomed request is ever built from the stale value.
      expect(() => getArtifactsToken('worker')).toThrow(/needs an upload token/)
      expect(() => getArtifactsToken('worker')).toThrow(/OCC_ARTIFACTS_TOKEN/)
    } finally {
      if (savedOcc !== undefined) process.env.OCC_ARTIFACTS_TOKEN = savedOcc
      if (savedClaude !== undefined)
        process.env.CLAUDE_ARTIFACTS_TOKEN = savedClaude
    }
  })

  test('the stale constant is kept for deployments that still accept it', async () => {
    const savedOcc = process.env.OCC_ARTIFACTS_TOKEN
    process.env.OCC_ARTIFACTS_TOKEN = 'explicit'
    try {
      const { getArtifactsToken, ARTIFACTS_DEFAULT_TOKEN } = await import(
        '../config.js'
      )
      expect(getArtifactsToken('worker')).toBe('explicit')
      expect(ARTIFACTS_DEFAULT_TOKEN).not.toContain('claude-code-best')
    } finally {
      if (savedOcc === undefined) delete process.env.OCC_ARTIFACTS_TOKEN
      else process.env.OCC_ARTIFACTS_TOKEN = savedOcc
    }
  })
})
