import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { occConfigDir } from 'src/config/paths.js'
import { resetStateForTests, setOriginalCwd } from '../../../bootstrap/state.js'
import { getProjectDir } from '../paths.js'
import { searchSessionsByCustomTitle } from '../sessionListing.js'
import { getSessionIdFromLog } from '../logAssembly.js'

const originalConfigDir = process.env.OCC_CONFIG_DIR
let root = ''
let project = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-title-search-'))
  project = join(root, 'project')
  process.env.OCC_CONFIG_DIR = join(root, 'config')
  occConfigDir.cache.clear?.()
  getProjectDir.cache.clear?.()
  setOriginalCwd(project)
})

afterEach(async () => {
  resetStateForTests()
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
  occConfigDir.cache.clear?.()
  getProjectDir.cache.clear?.()
  await rm(root, { recursive: true, force: true })
})

async function writeSession(sessionId: string, title: string): Promise<void> {
  const file = join(getProjectDir(project), `${sessionId}.jsonl`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({
        type: 'user',
        uuid: `${sessionId}-message`,
        parentUuid: null,
        sessionId,
        cwd: project,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({ type: 'custom-title', sessionId, customTitle: title }),
    ].join('\n') + '\n',
  )
}

describe('searchSessionsByCustomTitle', () => {
  test('matches an exact title case-insensitively after trimming', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    await writeSession(sessionId, 'Release Triage')

    const matches = await searchSessionsByCustomTitle('  release triage  ', {
      exact: true,
    })

    expect(matches).toHaveLength(1)
    expect(getSessionIdFromLog(matches[0]!)).toBe(sessionId)
  })

  test('returns distinct sessions sharing the same exact title', async () => {
    await writeSession('11111111-1111-4111-8111-111111111111', 'Shared title')
    await writeSession('22222222-2222-4222-8222-222222222222', 'Shared title')

    const matches = await searchSessionsByCustomTitle('shared title', {
      exact: true,
    })

    expect(matches.map(getSessionIdFromLog).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ])
  })
})
