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
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupSessionStorageMock } from '../../../../tests/mocks/sessionStorage.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

let projectsDir = ''
let cleanupPeriodDays = 30
const settingsMock = setupSettingsMock()
const sessionStorageMock = setupSessionStorageMock()
let cleanupOldSessionFiles: typeof import('../cleanup.js').cleanupOldSessionFiles

beforeAll(async () => {
  settingsMock.set({
    getSettings_DEPRECATED: () => ({ cleanupPeriodDays }),
  })
  sessionStorageMock.set({ getProjectsDir: () => projectsDir })
  ;({ cleanupOldSessionFiles } = await import('../cleanup.js'))
})

afterAll(() => {
  settingsMock.reset()
  sessionStorageMock.reset()
})

let tempRoot = ''

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'occ-cleanup-test-'))
  projectsDir = join(tempRoot, 'projects')
  cleanupPeriodDays = 30
  await mkdir(projectsDir, { recursive: true })
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

async function writeWithMtime(
  path: string,
  contents: string,
  mtime: Date,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
  await utimes(path, mtime, mtime)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

describe('cleanupOldSessionFiles managed roots', () => {
  test('recurses through tool-results and subagents without traversing sidecars or symlinks', async () => {
    const sessionDir = join(projectsDir, 'project-a', 'session-a')
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const newDate = new Date()

    const oldToolResult = join(
      sessionDir,
      'tool-results',
      'tool-a',
      'nested',
      'old.txt',
    )
    const newToolResult = join(
      sessionDir,
      'tool-results',
      'tool-a',
      'nested',
      'new.txt',
    )
    const oldSubagent = join(
      sessionDir,
      'subagents',
      'workflows',
      'run-a',
      'deep',
      'agent-old.jsonl',
    )
    const newSubagent = join(
      sessionDir,
      'subagents',
      'workflows',
      'run-b',
      'agent-new.jsonl',
    )
    await writeWithMtime(oldToolResult, 'old tool output', oldDate)
    await writeWithMtime(newToolResult, 'new tool output', newDate)
    await writeWithMtime(oldSubagent, 'old subagent output', oldDate)
    await writeWithMtime(newSubagent, 'new subagent output', newDate)

    const externalDir = join(tempRoot, 'external-target')
    const externalFile = join(externalDir, 'outside.txt')
    await writeWithMtime(externalFile, 'must survive', oldDate)
    const externalLink = join(sessionDir, 'subagents', 'external-link')
    await symlink(externalDir, externalLink, 'dir')

    const remoteAgentSidecar = join(
      sessionDir,
      'remote-agents',
      'remote-agent.meta.json',
    )
    const sessionMemorySidecar = join(
      sessionDir,
      'session-memory',
      'memory.json',
    )
    const otherSidecar = join(sessionDir, 'other-sidecar', 'nested', 'old.json')
    await writeWithMtime(remoteAgentSidecar, 'remote', oldDate)
    await writeWithMtime(sessionMemorySidecar, 'memory', oldDate)
    await writeWithMtime(otherSidecar, 'other', oldDate)

    const result = await cleanupOldSessionFiles()

    expect(result).toEqual({ messages: 2, errors: 0 })
    expect(await pathExists(oldToolResult)).toBe(false)
    expect(await pathExists(oldSubagent)).toBe(false)
    expect(
      await pathExists(join(sessionDir, 'subagents', 'workflows', 'run-a')),
    ).toBe(false)
    expect(await pathExists(newToolResult)).toBe(true)
    expect(await pathExists(newSubagent)).toBe(true)
    expect(await pathExists(externalLink)).toBe(true)
    expect(await readFile(externalFile, 'utf8')).toBe('must survive')
    expect(await pathExists(remoteAgentSidecar)).toBe(true)
    expect(await pathExists(sessionMemorySidecar)).toBe(true)
    expect(await pathExists(otherSidecar)).toBe(true)
  })

  test('does not traverse a symlinked managed root', async () => {
    const sessionDir = join(projectsDir, 'project-link', 'session-link')
    await mkdir(sessionDir, { recursive: true })
    const externalDir = join(tempRoot, 'external-root-target')
    const externalFile = join(externalDir, 'old.txt')
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await writeWithMtime(externalFile, 'must survive', oldDate)
    const managedRoot = join(sessionDir, 'subagents')
    await symlink(externalDir, managedRoot, 'dir')

    const result = await cleanupOldSessionFiles()

    expect(result).toEqual({ messages: 0, errors: 0 })
    expect(await pathExists(managedRoot)).toBe(true)
    expect(await readFile(externalFile, 'utf8')).toBe('must survive')
  })

  test('honors cleanupPeriodDays=0', async () => {
    cleanupPeriodDays = 0
    const recentFile = join(
      projectsDir,
      'project-zero',
      'session-zero',
      'subagents',
      'agent-recent.jsonl',
    )
    const recentDate = new Date(Date.now() - 1_000)
    await writeWithMtime(recentFile, 'recent', recentDate)

    const result = await cleanupOldSessionFiles()

    expect(result).toEqual({ messages: 1, errors: 0 })
    expect(await pathExists(recentFile)).toBe(false)
  })
})
