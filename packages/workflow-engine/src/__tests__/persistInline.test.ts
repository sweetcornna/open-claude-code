import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { persistInlineScript } from '../tool/persistInline.js'

test('persists to <cwd>/.occ/workflow-runs/<runId>/script.js and returns path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-pi-'))
  try {
    const path = await persistInlineScript('return 1', 'r1', dir)
    expect(path).toBe(join(dir, '.occ', 'workflow-runs', 'r1', 'script.js'))
    expect(await readFile(path, 'utf-8')).toBe('return 1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('accepts a host-provided workflow runs directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-pi-'))
  try {
    const path = await persistInlineScript(
      'return 1',
      'r-custom',
      dir,
      '.custom/workflow-runs',
    )
    expect(path).toBe(
      join(dir, '.custom', 'workflow-runs', 'r-custom', 'script.js'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('same runId repeated writes overwrite (mkdir idempotent, no error)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-pi-'))
  try {
    await persistInlineScript('first', 'r2', dir)
    const path = await persistInlineScript('second', 'r2', dir)
    expect(await readFile(path, 'utf-8')).toBe('second')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('different runId do not interfere (independent subdirectories)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-pi-'))
  try {
    const p1 = await persistInlineScript('a', 'run-a', dir)
    const p2 = await persistInlineScript('b', 'run-b', dir)
    expect(p1).not.toBe(p2)
    expect(await readFile(p1, 'utf-8')).toBe('a')
    expect(await readFile(p2, 'utf-8')).toBe('b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// A repository can ship `<project>/.occ` as a symlink pointing elsewhere.
// Path joining is lexical, so without resolving symlinks the inline script —
// attacker-influenced JS — would be written outside the project the user
// opened. Upstream hit the same bug with `.claude`.
describe('symlinked config directory cannot redirect writes', () => {
  test('refuses to write through a config-dir symlink, and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-symlink-'))
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(project, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(project, '.occ'))

    try {
      await expect(
        persistInlineScript(
          'console.log(1)',
          'w1234abcd',
          project,
          '.occ/workflow-runs',
        ),
      ).rejects.toThrow(/outside the project/)
      expect(existsSync(join(outside, 'workflow-runs'))).toBe(false)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test('a normal project directory still writes', async () => {
    const project = mkdtempSync(join(tmpdir(), 'wf-normal-'))
    try {
      const filePath = await persistInlineScript(
        'console.log(1)',
        'w1234abcd',
        project,
      )
      expect(existsSync(filePath)).toBe(true)
      expect(filePath.startsWith(project)).toBe(true)
    } finally {
      rmSync(project, { force: true, recursive: true })
    }
  })

  test('rejects a traversing run id before touching the filesystem', async () => {
    const project = mkdtempSync(join(tmpdir(), 'wf-runid-'))
    try {
      await expect(
        persistInlineScript('x', '../../escape', project),
      ).rejects.toThrow(/Invalid workflow run id/)
    } finally {
      rmSync(project, { force: true, recursive: true })
    }
  })
})
