/**
 * `occ project purge` plan building and execution.
 *
 * No module mocks: the planners take their config root as an argument and the
 * executor takes the config-key remover as a callback, so a real temp
 * directory exercises the real fs code paths.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyPurgeItem,
  buildAllProjectsPurgePlan,
  buildProjectPurgePlan,
  describePurgePlan,
  type PurgeItem,
} from '../projectPurge.js'
import { sanitizePath } from '../../../utils/session/sessionStoragePortable.js'

let configDir: string
const PROJECT = '/tmp/occ-purge-fixture/alpha'
const OTHER_PROJECT = '/tmp/occ-purge-fixture/alpha-beta'
const SESSION = '11111111-2222-3333-4444-555555555555'

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-purge-'))

  const projectDir = join(configDir, 'projects', sanitizePath(PROJECT))
  write(join(projectDir, `${SESSION}.jsonl`), '{"type":"user"}\n')
  write(join(projectDir, 'memory', 'notes.md'), 'remembered\n')

  // A different project whose sanitized name shares a prefix with ours —
  // the regression guard for prefix matching.
  const otherDir = join(configDir, 'projects', sanitizePath(OTHER_PROJECT))
  write(join(otherDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), '{}\n')

  write(join(configDir, 'tasks', SESSION, 'task-1.json'), '{}')
  write(join(configDir, 'debug', `${SESSION}.txt`), 'log')
  write(join(configDir, 'file-history', SESSION, 'abc@v1'), 'old')
  mkdirSync(join(configDir, 'shell-snapshots'), { recursive: true })

  write(
    join(configDir, 'history.jsonl'),
    [
      JSON.stringify({ display: 'mine', project: PROJECT, timestamp: 1 }),
      JSON.stringify({
        display: 'theirs',
        project: OTHER_PROJECT,
        timestamp: 2,
      }),
      'not json at all',
      '',
    ].join('\n'),
  )
})

afterEach(() => {
  rmSync(configDir, { force: true, recursive: true })
})

function pathsOfKind(items: PurgeItem[], kind: PurgeItem['kind']): string[] {
  return items.filter(item => item.kind === kind).map(item => item.path)
}

describe('buildProjectPurgePlan', () => {
  test('collects transcripts, per-session caches, the config key and history', async () => {
    const plan = await buildProjectPurgePlan(PROJECT, {
      configDir,
      projectKeys: [PROJECT, OTHER_PROJECT],
    })

    expect(pathsOfKind(plan.items, 'dir')).toEqual([
      join(configDir, 'tasks', SESSION),
      join(configDir, 'file-history', SESSION),
      join(configDir, 'projects', sanitizePath(PROJECT)),
    ])
    expect(pathsOfKind(plan.items, 'file')).toEqual([
      join(configDir, 'debug', `${SESSION}.txt`),
    ])
    expect(pathsOfKind(plan.items, 'config-key')).toEqual([PROJECT])
    expect(pathsOfKind(plan.items, 'history-lines')).toEqual([
      join(configDir, 'history.jsonl'),
    ])
  })

  test('never claims a sibling project whose sanitized name shares a prefix', async () => {
    const plan = await buildProjectPurgePlan(PROJECT, {
      configDir,
      projectKeys: [PROJECT, OTHER_PROJECT],
    })
    const otherDir = join(configDir, 'projects', sanitizePath(OTHER_PROJECT))
    expect(plan.items.map(item => item.path)).not.toContain(otherDir)
    expect(plan.items.map(item => item.path)).not.toContain(OTHER_PROJECT)
  })

  test('warns that shell snapshots are out of scope and never lists them', async () => {
    const plan = await buildProjectPurgePlan(PROJECT, {
      configDir,
      projectKeys: [],
    })
    expect(plan.warnings.join(' ')).toContain('shell-snapshots')
    expect(plan.items.map(item => item.path)).not.toContain(
      join(configDir, 'shell-snapshots'),
    )
  })

  test('a project with no state yields an empty plan', async () => {
    const plan = await buildProjectPurgePlan('/tmp/occ-purge-fixture/never', {
      configDir,
      projectKeys: [PROJECT],
    })
    expect(plan.items).toEqual([])
  })
})

describe('buildAllProjectsPurgePlan', () => {
  test('takes the whole state directories plus every config key', async () => {
    const plan = await buildAllProjectsPurgePlan({
      configDir,
      projectKeys: [PROJECT, OTHER_PROJECT],
    })
    expect(pathsOfKind(plan.items, 'dir')).toEqual([
      join(configDir, 'projects'),
      join(configDir, 'tasks'),
      join(configDir, 'debug'),
      join(configDir, 'file-history'),
    ])
    expect(pathsOfKind(plan.items, 'file')).toEqual([
      join(configDir, 'history.jsonl'),
    ])
    expect(pathsOfKind(plan.items, 'config-key')).toEqual([
      PROJECT,
      OTHER_PROJECT,
    ])
    expect(plan.items.map(item => item.path)).not.toContain(
      join(configDir, 'shell-snapshots'),
    )
  })
})

describe('applyPurgeItem', () => {
  test('removes directories and files', async () => {
    const projectDir = join(configDir, 'projects', sanitizePath(PROJECT))
    expect(
      await applyPurgeItem(
        { kind: 'dir', path: projectDir, reason: '' },
        async () => true,
      ),
    ).toBeNull()
    expect(() => readFileSync(join(projectDir, `${SESSION}.jsonl`))).toThrow()
  })

  test('rewrites history.jsonl keeping other projects and unparseable lines', async () => {
    const historyPath = join(configDir, 'history.jsonl')
    const failure = await applyPurgeItem(
      {
        kind: 'history-lines',
        path: historyPath,
        reason: '',
        matchPaths: [PROJECT],
      },
      async () => true,
    )
    expect(failure).toBeNull()
    const remaining = readFileSync(historyPath, 'utf8').trim().split('\n')
    expect(remaining).toHaveLength(2)
    expect(remaining[0]).toContain('theirs')
    expect(remaining[1]).toBe('not json at all')
  })

  test('reports a config-key removal that did not take', async () => {
    const failure = await applyPurgeItem(
      { kind: 'config-key', path: PROJECT, reason: '' },
      async () => false,
    )
    expect(failure).toContain(PROJECT)
  })
})

describe('describePurgePlan', () => {
  test('names every item and surfaces the warnings', async () => {
    const plan = await buildProjectPurgePlan(PROJECT, {
      configDir,
      projectKeys: [PROJECT],
    })
    const rendered = describePurgePlan(PROJECT, plan)
    expect(rendered).toContain(`Purge plan for ${PROJECT}`)
    expect(rendered).toContain(`config: projects["${PROJECT}"]`)
    expect(rendered).toContain('shell-snapshots')
  })
})
