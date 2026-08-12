/**
 * The pure half of `/background`: what argv the child gets, what env it does
 * not get, and what the user is told afterwards. No mocks — the module only
 * imports `occConfigPath` and the job store, and the temp config dir is real.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { BIN_NAME } from '../../../constants/brand.js'
import {
  HANDOFF_STRIPPED_ENV_KEYS,
  formatHandoffHints,
  planHandoff,
  sanitizeHandoffEnv,
} from '../handoff.js'

const originalConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-handoff-'))
  process.env.OCC_CONFIG_DIR = tempDir
})

afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
  await rm(tempDir, { recursive: true, force: true })
})

describe('sanitizeHandoffEnv', () => {
  test('drops every session/job identity key', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    for (const key of HANDOFF_STRIPPED_ENV_KEYS) env[key] = 'stale'
    env.CLAUDE_BG_PTY_AUTH = 'stale'
    env.CLAUDE_BG_ANYTHING = 'stale'

    const result = sanitizeHandoffEnv(env)

    expect(result.PATH).toBe('/usr/bin')
    for (const key of HANDOFF_STRIPPED_ENV_KEYS) {
      expect(result[key]).toBeUndefined()
    }
    expect(result.CLAUDE_BG_PTY_AUTH).toBeUndefined()
    expect(result.CLAUDE_BG_ANYTHING).toBeUndefined()
  })

  test('keeps credentials — they are not identity', () => {
    const result = sanitizeHandoffEnv({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'sk-ant-sid-test',
      CLAUDE_CODE_SESSION_KIND: 'bg',
    })
    expect(result.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(result.CLAUDE_CODE_SESSION_ACCESS_TOKEN).toBe('sk-ant-sid-test')
    expect(result.CLAUDE_CODE_SESSION_KIND).toBeUndefined()
  })

  test('does not mutate the input', () => {
    const env = { CLAUDE_CODE_SESSION_KIND: 'bg' }
    sanitizeHandoffEnv(env)
    expect(env.CLAUDE_CODE_SESSION_KIND).toBe('bg')
  })
})

describe('planHandoff', () => {
  const base = {
    sessionId: 'source-session',
    cwd: '/tmp/project',
    forkSessionId: 'fork-session',
    jobId: 'a1b2c3d4',
  }

  test('resumes as a fork with a predetermined session id', () => {
    const plan = planHandoff({ ...base, interactive: true })
    expect(plan.args).toEqual([
      '--resume',
      'source-session',
      '--fork-session',
      '--session-id',
      'fork-session',
    ])
    expect(plan.sessionName).toBe(`${BIN_NAME}-bg-a1b2c3d4`)
    expect(plan.logPath).toBe(
      join(tempDir, 'sessions', 'logs', `${BIN_NAME}-bg-a1b2c3d4.log`),
    )
    expect(plan.forkSessionId).toBe('fork-session')
    expect(plan.cwd).toBe('/tmp/project')
  })

  test('passes a prompt as an operand so a leading dash is not a flag', () => {
    const plan = planHandoff({
      ...base,
      interactive: true,
      prompt: '--not-a-flag please',
    })
    expect(plan.args.slice(-2)).toEqual(['--', '--not-a-flag please'])
  })

  test('adds -p when the engine has no terminal', () => {
    const plan = planHandoff({ ...base, interactive: false, prompt: 'go' })
    expect(plan.args).toContain('-p')
    expect(plan.args.indexOf('-p')).toBeLessThan(plan.args.indexOf('--'))
  })

  test('generates a job id when none is supplied', () => {
    const plan = planHandoff({
      sessionId: 's',
      cwd: '/tmp',
      forkSessionId: 'f',
      interactive: true,
    })
    expect(plan.jobId).toMatch(/^[0-9a-f]{8}$/)
    expect(plan.sessionName).toBe(`${BIN_NAME}-bg-${plan.jobId}`)
    // The log filename must stay in the shape removeManagedSessionLog accepts,
    // or the log outlives every session that created it.
    expect(plan.logPath.endsWith(`${plan.sessionName}.log`)).toBe(true)
  })
})

describe('formatHandoffHints', () => {
  test('names the session and the four follow-up commands', () => {
    const plan = planHandoff({
      sessionId: 's',
      cwd: '/tmp',
      forkSessionId: 'f',
      interactive: true,
      jobId: 'a1b2c3d4',
    })
    const hints = formatHandoffHints(plan, 'fix the parser')

    expect(hints).toContain(
      `backgrounded · ${plan.sessionName} · fix the parser`,
    )
    expect(hints).toContain(`${BIN_NAME} agents`)
    expect(hints).toContain(`${BIN_NAME} daemon attach ${plan.sessionName}`)
    expect(hints).toContain(`${BIN_NAME} daemon logs ${plan.sessionName}`)
    expect(hints).toContain(`${BIN_NAME} stop ${plan.sessionName}`)
  })

  test('omits the title separator when there is no title', () => {
    const plan = planHandoff({
      sessionId: 's',
      cwd: '/tmp',
      forkSessionId: 'f',
      interactive: true,
      jobId: 'a1b2c3d4',
    })
    expect(formatHandoffHints(plan).split('\n')[0]).toBe(
      `backgrounded · ${plan.sessionName}`,
    )
  })
})
