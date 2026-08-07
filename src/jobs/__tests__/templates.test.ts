/**
 * Tests for src/jobs/templates.ts
 *
 * Uses real temp directories and CLAUDE_CONFIG_DIR env var
 * instead of mocking fs, to avoid cross-test mock pollution.
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── setup: real temp dir via env var ──────────────────────────────────────

const tempBase = mkdtempSync(join(tmpdir(), 'jobs-templates-test-'))

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousOccConfigDir = process.env.OCC_CONFIG_DIR

beforeEach(() => {
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

const { listTemplates, loadTemplate } = await import('../templates.js')

// ─── tests ──────────────────────────────────────────────────────────────────

describe('listTemplates', () => {
  test('returns empty array when no template dirs exist', () => {
    const result = listTemplates()
    expect(result).toEqual([])
  })

  test('discovers templates from user-level dir', () => {
    const userDir = join(process.env.CLAUDE_CONFIG_DIR!, 'templates')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(
      join(userDir, 'greeting.md'),
      '---\ndescription: A greeting template\n---\nHello {{name}}',
      'utf-8',
    )

    const result = listTemplates()
    expect(result.length).toBe(1)
    expect(result[0]!.name).toBe('greeting')
    expect(result[0]!.description).toBe('A greeting template')
    expect(result[0]!.content).toBe('Hello {{name}}')
  })

  test('skips non-md files', () => {
    const userDir = join(process.env.CLAUDE_CONFIG_DIR!, 'templates')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'notes.txt'), 'not a template', 'utf-8')
    writeFileSync(join(userDir, 'data.json'), '{}', 'utf-8')

    const result = listTemplates()
    expect(result).toEqual([])
  })
})

describe('loadTemplate', () => {
  test('returns null when template not found', () => {
    expect(loadTemplate('nonexistent')).toBeNull()
  })

  test('returns template by name', () => {
    const userDir = join(process.env.CLAUDE_CONFIG_DIR!, 'templates')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(
      join(userDir, 'deploy.md'),
      '---\ndescription: Deploy script\n---\nrun deploy',
      'utf-8',
    )

    const result = loadTemplate('deploy')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('deploy')
  })
})
