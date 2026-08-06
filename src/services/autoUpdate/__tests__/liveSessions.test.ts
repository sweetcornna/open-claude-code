/**
 * Tests for the live-session registry (liveSessions.ts).
 *
 * Everything runs against a temp OCC_CONFIG_DIR — `occConfigDir` is memoized
 * on the env var, so pointing it at a scratch directory is enough to keep the
 * user's real ~/.occ untouched.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let live: typeof import('../liveSessions.js')
let distRootValue: string
let configDir: string
const previousConfigDir = process.env.OCC_CONFIG_DIR

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-live-sessions-'))
  process.env.OCC_CONFIG_DIR = configDir
  live = await import('../liveSessions.js')
  distRootValue = (await import('src/utils/filesystem/distRoot.js')).distRoot
})

afterAll(() => {
  if (previousConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

function sessionsDir(): string {
  return join(configDir, 'live-sessions')
}

async function writeEntry(pid: number, root = distRootValue): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(join(sessionsDir(), String(pid)), root, 'utf8')
}

afterEach(async () => {
  live.resetLiveSessionsForTests()
  rmSync(sessionsDir(), { recursive: true, force: true })
})

/** A pid that is guaranteed to be gone: a child we already reaped. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['--version'])
  return result.pid ?? 2 ** 22
}

describe('registerLiveSession', () => {
  test('writes this process pid tagged with its dist root', async () => {
    live.registerLiveSession()
    // The write is fire-and-forget so the startup path never awaits it.
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))

    const entry = join(sessionsDir(), String(process.pid))
    expect(existsSync(entry)).toBe(true)
    expect(await readFile(entry, 'utf8')).toBe(distRootValue)
  })
})

describe('hasOtherLiveSessions', () => {
  test('is false when the registry does not exist yet', async () => {
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })

  test('ignores this process own entry', async () => {
    await writeEntry(process.pid)
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })

  test('reports another live process on the same dist root', async () => {
    // process.ppid is alive by construction and is not us.
    await writeEntry(process.ppid)
    expect(await live.hasOtherLiveSessions()).toBe(true)
  })

  test('ignores a live process running from a different dist root', async () => {
    // A `bun run dev` checkout is unaffected by replacing the global install.
    await writeEntry(process.ppid, '/somewhere/else/dist')
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })

  test('prunes entries whose process is gone, so a crash cannot block updates', async () => {
    const gone = deadPid()
    await writeEntry(gone)

    expect(await live.hasOtherLiveSessions()).toBe(false)
    expect(await readdir(sessionsDir())).not.toContain(String(gone))
  })

  test('a malformed filename is ignored rather than throwing', async () => {
    await mkdir(sessionsDir(), { recursive: true })
    await writeFile(join(sessionsDir(), 'not-a-pid'), distRootValue, 'utf8')
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })
})
