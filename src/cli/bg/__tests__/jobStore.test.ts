/**
 * Real temp directories, zero mocks — jobStore.ts imports only node builtins
 * and `occConfigPath`, so there is nothing here worth faking. The path-guard
 * and refusal tests in particular are only meaningful against a real
 * filesystem: they exist to prove that a hand-edited registry cannot make the
 * store delete something outside its own directory.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireJobLock,
  deleteJobRecord,
  evaluateJobRemoval,
  findJob,
  isJobId,
  type JobRemovalFacts,
  jobFilePath,
  jobIdFromSessionName,
  jobsDir,
  listJobIds,
  listJobs,
  markJobTerminal,
  newJobId,
  readJob,
  readJobLock,
  readJobRecord,
  updateJob,
  writeJob,
} from '../jobStore.js'

const originalConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-jobstore-'))
  process.env.OCC_CONFIG_DIR = tempDir
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
})

function facts(overrides: Partial<JobRemovalFacts> = {}): JobRemovalFacts {
  return {
    jobId: 'a1b2c3d4',
    recordReadable: true,
    processAlive: false,
    ...overrides,
  }
}

describe('job ids', () => {
  test('accepts exactly 8 lowercase hex characters', () => {
    expect(isJobId('a1b2c3d4')).toBe(true)
    expect(isJobId('A1B2C3D4')).toBe(false)
    expect(isJobId('a1b2c3d')).toBe(false)
    expect(isJobId('a1b2c3d45')).toBe(false)
    expect(isJobId('../../etc')).toBe(false)
    expect(isJobId(undefined)).toBe(false)
  })

  test('generated ids are job ids', () => {
    for (let i = 0; i < 20; i++) expect(isJobId(newJobId())).toBe(true)
  })

  test('derives a job id from a launcher session name only', () => {
    expect(jobIdFromSessionName('occ-bg-a1b2c3d4')).toBe('a1b2c3d4')
    expect(jobIdFromSessionName('my-session')).toBeUndefined()
    expect(jobIdFromSessionName('occ-bg-../../evil')).toBeUndefined()
    expect(jobIdFromSessionName(undefined)).toBeUndefined()
  })
})

describe('path guard', () => {
  test('resolves a job id to a direct child of the managed directory', () => {
    expect(jobFilePath('a1b2c3d4')).toBe(join(jobsDir(), 'a1b2c3d4.json'))
  })

  test('refuses anything that is not a bare job id', () => {
    for (const bad of [
      '../escape',
      'a1b2c3d4/../../oops',
      'nested/a1b2c3d4',
      '',
      '.',
      'a1b2c3d4.json',
    ]) {
      expect(jobFilePath(bad)).toBeUndefined()
    }
  })

  test('deleteJobRecord will not unlink through a non-job-id target', async () => {
    const bystander = join(tempDir, 'precious.json')
    await writeFile(bystander, 'keep me')

    expect(await deleteJobRecord('../precious')).toBe(false)
    expect(await deleteJobRecord('precious')).toBe(false)
    expect(await readFile(bystander, 'utf8')).toBe('keep me')
  })
})

describe('records', () => {
  test('round-trips a record and lists it', async () => {
    await writeJob({
      jobId: 'a1b2c3d4',
      state: 'running',
      name: 'occ-bg-a1b2c3d4',
      sessionId: 'session-1',
      pid: 4242,
      cwd: '/tmp/project',
      logPath: '/tmp/log',
      engine: 'tmux',
      tempo: 'active',
    })

    const record = await readJob('a1b2c3d4')
    expect(record?.state).toBe('running')
    expect(record?.name).toBe('occ-bg-a1b2c3d4')
    expect(record?.pid).toBe(4242)
    expect(record?.createdAt).toBeGreaterThan(0)
    expect(await listJobIds()).toEqual(['a1b2c3d4'])
    expect((await listJobs()).map(job => job.jobId)).toEqual(['a1b2c3d4'])
  })

  test('the filename is the authority for the job id', async () => {
    await mkdir(jobsDir(), { recursive: true })
    await writeFile(
      join(jobsDir(), 'a1b2c3d4.json'),
      JSON.stringify({ jobId: 'ffffffff', state: 'running' }),
    )
    expect((await readJob('a1b2c3d4'))?.jobId).toBe('a1b2c3d4')
  })

  test('distinguishes missing from unreadable', async () => {
    expect((await readJobRecord('a1b2c3d4')).status).toBe('missing')

    await mkdir(jobsDir(), { recursive: true })
    await writeFile(join(jobsDir(), 'b1b2c3d4.json'), '{ not json')
    expect((await readJobRecord('b1b2c3d4')).status).toBe('unreadable')

    await writeFile(
      join(jobsDir(), 'c1b2c3d4.json'),
      JSON.stringify({ state: 'exploded' }),
    )
    expect((await readJobRecord('c1b2c3d4')).status).toBe('unreadable')
  })

  test('listJobs skips unreadable records instead of throwing', async () => {
    await writeJob({ jobId: 'a1b2c3d4', state: 'running' })
    await writeFile(join(jobsDir(), 'b1b2c3d4.json'), 'garbage')
    await writeFile(join(jobsDir(), 'notes.txt'), 'ignored')

    expect((await listJobs()).map(job => job.jobId)).toEqual(['a1b2c3d4'])
    expect(await listJobIds()).toEqual(['a1b2c3d4', 'b1b2c3d4'])
  })

  test('markJobTerminal freezes firstTerminalAt across repeat transitions', async () => {
    await writeJob({ jobId: 'a1b2c3d4', state: 'running' })
    const stopped = await markJobTerminal('a1b2c3d4', {
      state: 'stopped',
      detail: 'stopped',
    })
    expect(stopped?.state).toBe('stopped')
    expect(stopped?.tempo).toBe('idle')
    const firstTerminalAt = stopped?.firstTerminalAt
    expect(firstTerminalAt).toBeGreaterThan(0)

    const killed = await markJobTerminal('a1b2c3d4', {
      state: 'failed',
      detail: 'killed',
    })
    expect(killed?.state).toBe('failed')
    expect(killed?.firstTerminalAt).toBe(firstTerminalAt!)
  })

  test('updateJob is a no-op for a job that does not exist', async () => {
    expect(await updateJob('a1b2c3d4', { detail: 'x' })).toBeUndefined()
  })

  test('finds a job by id, name, session id or pid', async () => {
    await writeJob({
      jobId: 'a1b2c3d4',
      state: 'running',
      name: 'occ-bg-a1b2c3d4',
      sessionId: 'session-1',
      pid: 777,
    })
    expect((await findJob('a1b2c3d4'))?.jobId).toBe('a1b2c3d4')
    expect((await findJob('occ-bg-a1b2c3d4'))?.jobId).toBe('a1b2c3d4')
    expect((await findJob('session-1'))?.jobId).toBe('a1b2c3d4')
    expect((await findJob('777'))?.jobId).toBe('a1b2c3d4')
    expect(await findJob('nope')).toBeUndefined()
  })
})

describe('locks', () => {
  test('a second acquire fails while the first is held', async () => {
    const first = await acquireJobLock('a1b2c3d4')
    expect(first).toBeDefined()
    expect(await acquireJobLock('a1b2c3d4')).toBeUndefined()
    await first!.release()
    const second = await acquireJobLock('a1b2c3d4')
    expect(second).toBeDefined()
    await second!.release()
  })

  test('a lock held by a dead process is reclaimed', async () => {
    await mkdir(jobsDir(), { recursive: true })
    // PID 2^22 is above every default pid_max and is not running.
    await writeFile(
      join(jobsDir(), 'a1b2c3d4.lock'),
      JSON.stringify({ pid: 4194304, at: Date.now() }),
    )
    expect(await readJobLock('a1b2c3d4')).toBeUndefined()
    const lock = await acquireJobLock('a1b2c3d4')
    expect(lock).toBeDefined()
    await lock!.release()
  })

  test('an expired lock is reclaimed even when its holder is alive', async () => {
    await mkdir(jobsDir(), { recursive: true })
    await writeFile(
      join(jobsDir(), 'a1b2c3d4.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now() - 60 * 60 * 1000 }),
    )
    expect(await readJobLock('a1b2c3d4')).toBeUndefined()
    const lock = await acquireJobLock('a1b2c3d4')
    expect(lock).toBeDefined()
    await lock!.release()
  })

  test('an unparseable lock does not make the job permanently unremovable', async () => {
    await mkdir(jobsDir(), { recursive: true })
    await writeFile(join(jobsDir(), 'a1b2c3d4.lock'), 'not json')
    expect(await readJobLock('a1b2c3d4')).toBeUndefined()
    const lock = await acquireJobLock('a1b2c3d4')
    expect(lock).toBeDefined()
    await lock!.release()
  })

  test('deleting a record clears its lock file', async () => {
    await writeJob({ jobId: 'a1b2c3d4', state: 'stopped' })
    const lock = await acquireJobLock('a1b2c3d4')
    expect(lock).toBeDefined()
    expect(await deleteJobRecord('a1b2c3d4')).toBe(true)
    expect(await Bun.file(join(jobsDir(), 'a1b2c3d4.lock')).exists()).toBe(
      false,
    )
  })
})

/**
 * One test per refusal reason. The set is transcribed from official's `rm`;
 * if a reason is ever dropped from the implementation this suite is where it
 * gets noticed.
 */
describe('removal refusals', () => {
  test('allows removal when nothing objects', () => {
    expect(evaluateJobRemoval(facts())).toEqual({ ok: true })
  })

  test('records_unreadable', () => {
    const decision = evaluateJobRemoval(facts({ recordReadable: false }))
    expect(decision).toMatchObject({ ok: false, reason: 'records_unreadable' })
  })

  test('live_lock', () => {
    const decision = evaluateJobRemoval(facts({ lockedByPid: 4242 }))
    expect(decision).toMatchObject({ ok: false, reason: 'live_lock' })
    expect(decision.ok === false && decision.message).toContain('4242')
  })

  test('unverified when a live process has no derivable identity', () => {
    expect(
      evaluateJobRemoval(facts({ processAlive: true, pid: 10 })),
    ).toMatchObject({ ok: false, reason: 'unverified' })
    expect(
      evaluateJobRemoval(
        facts({ processAlive: true, pid: 10, recordedMarker: 'proc:1' }),
      ),
    ).toMatchObject({ ok: false, reason: 'unverified' })
  })

  test('identity_changed when the PID was reused', () => {
    expect(
      evaluateJobRemoval(
        facts({
          processAlive: true,
          pid: 10,
          recordedMarker: 'proc:1',
          currentMarker: 'proc:2',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'identity_changed' })
  })

  test('occupied when the session is genuinely still running', () => {
    expect(
      evaluateJobRemoval(
        facts({
          processAlive: true,
          pid: 10,
          recordedMarker: 'proc:1',
          currentMarker: 'proc:1',
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'occupied' })
  })

  test('in_use when another live session holds the conversation', () => {
    expect(evaluateJobRemoval(facts({ claimedByPid: 99 }))).toMatchObject({
      ok: false,
      reason: 'in_use',
    })
  })

  test('shared_record when another job points at the same artifacts', () => {
    expect(
      evaluateJobRemoval(facts({ sharedWithJobId: 'ffffffff' })),
    ).toMatchObject({ ok: false, reason: 'shared_record' })
  })

  test('the most specific reason wins when several apply', () => {
    // Unreadable beats everything: without the record there is no way to know
    // what the other checks are even talking about.
    expect(
      evaluateJobRemoval(
        facts({
          recordReadable: false,
          lockedByPid: 1,
          processAlive: true,
          claimedByPid: 2,
          sharedWithJobId: 'ffffffff',
        }),
      ),
    ).toMatchObject({ reason: 'records_unreadable' })

    expect(
      evaluateJobRemoval(
        facts({ lockedByPid: 1, processAlive: true, claimedByPid: 2 }),
      ),
    ).toMatchObject({ reason: 'live_lock' })

    expect(
      evaluateJobRemoval(
        facts({ claimedByPid: 2, sharedWithJobId: 'ffffffff' }),
      ),
    ).toMatchObject({ reason: 'in_use' })
  })
})
