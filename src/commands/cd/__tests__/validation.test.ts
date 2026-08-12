/**
 * These tests must never read the ambient session cwd. `mock.module` is
 * process-global and several suites in this shard (share-projectdir,
 * launchAutofixPr) pin `getCwdState` to a non-existent '/mock/cwd' with
 * `setCwdState` no-op'd, so anything resolved against the session cwd comes
 * back not_found once one of them has loaded — and it cannot be repaired from
 * here. Every case below owns its directories and passes them in explicitly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { cdFailureMessage, validateCdTarget } from '../validation.js'

/** Canonical (realpath'd) roots, since macOS tmpdir sits behind a symlink. */
let base: string
let here: string
let target: string

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'occ-cd-')))
  here = join(base, 'here')
  target = join(base, 'target')
  await mkdir(here)
  await mkdir(target)
  await mkdir(join(here, 'child'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('validateCdTarget', () => {
  test('resolves an existing directory to its canonical path', async () => {
    const result = await validateCdTarget(target, here)
    expect(result.result).toBe('ok')
    if (result.result !== 'ok') return
    expect(result.directory).toBe(target)
  })

  test('reports the session cwd itself as "same"', async () => {
    const result = await validateCdTarget(here, here)
    expect(result.result).toBe('same')
  })

  // Doubles as the ambient-cwd guard: `here` is a temp directory unrelated to
  // both process.cwd() and the session cwd, so if the sessionCwd argument ever
  // stopped being threaded into expandPath this would resolve somewhere else
  // and fail. (Deliberately no process.chdir here — a test that mutates the
  // process cwd is the very hazard this suite exists to survive.)
  test('resolves relative paths against the session cwd', async () => {
    const result = await validateCdTarget('child', here)
    expect(result.result).toBe('ok')
    if (result.result !== 'ok') return
    expect(result.directory).toBe(join(here, 'child'))
  })

  test('reports a missing path as not_found', async () => {
    const missing = join(base, 'nope')
    const result = await validateCdTarget(missing, here)
    expect(result).toEqual({ result: 'not_found', path: missing })
  })

  test('reports a file as not_a_directory with its parent', async () => {
    const file = join(base, 'file.txt')
    await writeFile(file, 'x')
    const result = await validateCdTarget(file, here)
    expect(result.result).toBe('not_a_directory')
    if (result.result !== 'not_a_directory') return
    expect(result.path).toBe(file)
    expect(result.parent).toBe(base)
  })
})

describe('cdFailureMessage', () => {
  test('names the path that was not found', () => {
    const message = cdFailureMessage({
      result: 'not_found',
      path: '/no/such/dir',
    })
    expect(message).toContain("Couldn't find a directory at")
    expect(message).toContain('/no/such/dir')
  })

  test('suggests the parent for a file target', () => {
    const message = cdFailureMessage({
      result: 'not_a_directory',
      path: '/tmp/a/file.txt',
      parent: '/tmp/a',
    })
    expect(message).toContain('is not a directory')
    expect(message).toContain('/tmp/a')
  })

  test('says "already in" for the current directory', () => {
    expect(cdFailureMessage({ result: 'same', directory: '/tmp/a' })).toContain(
      'Already in',
    )
  })
})
