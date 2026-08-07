/**
 * Tests for src/jobs/state.ts
 *
 * Uses real temp directories and CLAUDE_CONFIG_DIR env var
 * instead of mocking fs, to avoid cross-test mock pollution.
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── setup: real temp dir via env var ──────────────────────────────────────

const tempBase = mkdtempSync(join(tmpdir(), 'jobs-state-test-'))

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousOccConfigDir = process.env.OCC_CONFIG_DIR

beforeEach(() => {
  // Each test gets a fresh config dir
  const tempHome = mkdtempSync(join(tempBase, 'home-'))
  // occConfigDir() honours OCC_CONFIG_DIR before CLAUDE_CONFIG_DIR, so point
  // both at the temp home or a set OCC_CONFIG_DIR leaks in from the environment.
  process.env.CLAUDE_CONFIG_DIR = tempHome
  process.env.OCC_CONFIG_DIR = tempHome
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  if (previousOccConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = previousOccConfigDir
  try {
    rmSync(tempBase, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// ─── import ─────────────────────────────────────────────────────────────────

const { createJob, readJobState, appendJobReply, getJobDir } = await import(
  '../state.js'
)

// ─── tests ──────────────────────────────────────────────────────────────────

describe('createJob', () => {
  test('creates job directory and writes state, template, and input files', () => {
    const dir = createJob('job-1', 'my-template', '# Template', 'hello', [
      '--flag',
    ])
    expect(dir).toContain('job-1')
    expect(existsSync(dir)).toBe(true)

    const stateFile = join(dir, 'state.json')
    expect(existsSync(stateFile)).toBe(true)
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(state.jobId).toBe('job-1')
    expect(state.templateName).toBe('my-template')
    expect(state.status).toBe('created')
    expect(state.args).toEqual(['--flag'])

    expect(readFileSync(join(dir, 'template.md'), 'utf-8')).toBe('# Template')
    expect(readFileSync(join(dir, 'input.txt'), 'utf-8')).toBe('hello')
  })
})

describe('readJobState', () => {
  test('returns null when job does not exist', () => {
    expect(readJobState('nonexistent')).toBeNull()
  })

  test('returns parsed state when job exists', () => {
    createJob('job-2', 'tpl', 'content', 'input', [])
    const result = readJobState('job-2')
    expect(result).not.toBeNull()
    expect(result!.jobId).toBe('job-2')
    expect(result!.status).toBe('created')
  })
})

describe('appendJobReply', () => {
  test('returns false when job does not exist', () => {
    expect(appendJobReply('no-job', 'hello')).toBe(false)
  })

  test('appends reply and updates state', () => {
    createJob('job-3', 'tpl', 'content', 'input', [])

    const result = appendJobReply('job-3', 'my reply')
    expect(result).toBe(true)

    const dir = getJobDir('job-3')
    const repliesPath = join(dir, 'replies.jsonl')
    expect(existsSync(repliesPath)).toBe(true)
    const replyLine = JSON.parse(readFileSync(repliesPath, 'utf-8').trim())
    expect(replyLine.text).toBe('my reply')
  })
})
