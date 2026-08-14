import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readJob, writeJob } from '../../../cli/bg/jobStore.js'
import { isBgSession } from '../../../utils/session/concurrentSessions.js'
import stop from '../index.js'
import { recordStopped } from '../stop.js'

const JOB_ID = 'a1b2c3d4'
const SESSION_NAME = `occ-bg-${JOB_ID}`

let configDir: string
const savedEnv: Record<string, string | undefined> = {}

function saveEnv(...keys: string[]): void {
  for (const k of keys) savedEnv[k] = process.env[k]
}

beforeEach(() => {
  saveEnv(
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_SESSION_NAME',
    'CLAUDE_CODE_SESSION_KIND',
  )
  configDir = mkdtempSync(join(tmpdir(), 'occ-stop-test-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(configDir, { recursive: true, force: true })
})

async function seedRunningJob(): Promise<void> {
  await writeJob({
    jobId: JOB_ID,
    name: SESSION_NAME,
    state: 'running',
    tempo: 'active',
  })
}

describe('/stop descriptor', () => {
  test('is a local-jsx command named stop that runs immediately', () => {
    expect(stop.name).toBe('stop')
    expect(stop.type).toBe('local-jsx')
    expect(stop.immediate).toBe(true)
  })

  test('gates on isBgSession, so it is invisible outside a bg session', () => {
    // Identity rather than a value assertion: isBgSession() already returns
    // false when BG_SESSIONS is compiled out, so re-deriving the condition here
    // would let the two drift.
    expect(stop.isEnabled).toBe(isBgSession)
  })
})

describe('recordStopped', () => {
  test('moves this session job record to the stopped state', async () => {
    process.env.CLAUDE_CODE_SESSION_NAME = SESSION_NAME
    await seedRunningJob()

    expect(await recordStopped()).toBe(JOB_ID)

    const after = await readJob(JOB_ID)
    expect(after?.state).toBe('stopped')
    expect(after?.tempo).toBe('idle')
    // The record survives — `stop` keeps the conversation resumable; only `rm`
    // deletes it.
    expect(after?.jobId).toBe(JOB_ID)
  })

  test('is a no-op when the session name carries no job id', async () => {
    process.env.CLAUDE_CODE_SESSION_NAME = 'not-a-job-name'
    await seedRunningJob()

    expect(await recordStopped()).toBeUndefined()
    expect((await readJob(JOB_ID))?.state).toBe('running')
  })

  test('is a no-op when there is no record to mark', async () => {
    process.env.CLAUDE_CODE_SESSION_NAME = SESSION_NAME
    expect(await recordStopped()).toBeUndefined()
  })
})
