/**
 * The local backend is the default, so these assertions are the ones that
 * decide whether `artifact` works out of the box. Everything here touches a
 * real temp directory: an isolated OCC_CONFIG_DIR is exactly how a user
 * relocates the artifact directory, so faking the path would test nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  getLocalArtifactsDir,
  isLocalArtifactUrl,
  localStore,
} from '../localStore.js'

const savedOcc = process.env.OCC_CONFIG_DIR
const savedClaude = process.env.CLAUDE_CONFIG_DIR
let configDir: string

describe('localStore', () => {
  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), 'occ-artifact-local-'))
    process.env.OCC_CONFIG_DIR = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true })
    if (savedOcc === undefined) delete process.env.OCC_CONFIG_DIR
    else process.env.OCC_CONFIG_DIR = savedOcc
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaude
  })

  test('derives the directory from the occ config root', () => {
    expect(getLocalArtifactsDir()).toBe(join(configDir, 'artifacts'))
  })

  test('writes the page and returns an openable file:// URL', async () => {
    const result = await localStore.upload({
      html: '<h1>local</h1>',
      ttlDays: 7,
    })

    expect(result.url.startsWith('file://')).toBe(true)
    expect(isLocalArtifactUrl(result.url)).toBe(true)
    const filePath = fileURLToPath(result.url)
    expect(filePath).toBe(join(configDir, 'artifacts', `${result.id}.html`))
    expect(readFileSync(filePath, 'utf8')).toBe('<h1>local</h1>')
  })

  test('has no TTL: expiresAt is absent and ttlDays is ignored', async () => {
    const a = await localStore.upload({ html: '<p>a</p>', ttlDays: 7 })
    const b = await localStore.upload({ html: '<p>b</p>', ttlDays: 30 })

    expect(a.expiresAt).toBeUndefined()
    expect(b.expiresAt).toBeUndefined()
    expect(fileURLToPath(a.url)).not.toContain('7d')
    expect(fileURLToPath(b.url)).not.toContain('30d')
  })

  test('generates a fresh id when no hash is given', async () => {
    const first = await localStore.upload({ html: '<p>1</p>', ttlDays: 7 })
    const second = await localStore.upload({ html: '<p>2</p>', ttlDays: 7 })

    expect(first.id).not.toBe(second.id)
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })

  test('the same hash overwrites the same file and keeps the URL stable', async () => {
    const first = await localStore.upload({
      html: '<p>v1</p>',
      hash: 'my-report',
      ttlDays: 7,
    })
    const second = await localStore.upload({
      html: '<p>v2</p>',
      hash: 'my-report',
      ttlDays: 7,
    })

    expect(second.id).toBe('my-report')
    expect(second.url).toBe(first.url)
    expect(readFileSync(fileURLToPath(second.url), 'utf8')).toBe('<p>v2</p>')
  })

  test('rejects an id that would escape the artifacts directory', async () => {
    await expect(
      localStore.upload({ html: '<p>x</p>', hash: '../escape', ttlDays: 7 }),
    ).rejects.toThrow(/Invalid artifact hash/)
    expect(existsSync(join(configDir, 'escape.html'))).toBe(false)
  })

  test('isLocalArtifactUrl is false for a hosted URL', () => {
    expect(isLocalArtifactUrl('https://example.test/7d/abc.html')).toBe(false)
  })
})
