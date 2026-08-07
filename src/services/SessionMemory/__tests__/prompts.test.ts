import { afterAll, describe, test, expect, mock, beforeEach } from 'bun:test'
import { setupEffortMock } from '../../../../tests/mocks/effort.js'
import { setupEnvUtilsMock } from '../../../../tests/mocks/envUtils.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupModelMock } from '../../../../tests/mocks/model.js'
import type { EffortLevel } from 'src/utils/model/effort.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Mock infrastructure ─────────────────────────────────────────────────────
// All mock.module calls must precede the import of the module under test.
// mock.module is process-global, so every repo module mocked here goes through
// a shared complete-surface helper in tests/mocks/: non-overridden exports
// delegate to the real module and afterAll drops this suite's overrides for
// the rest of the process. This file previously hand-rolled model.js and
// effort.js (~28 and ~20 entries) with re-implemented copies of
// getDefaultOpusModel and firstPartyNameToCanonical, gated behind a sentinel
// flag so sibling suites would still see approximately-real behaviour. The
// helpers make that machinery unnecessary — see
// tests/mocks/sharedModuleMock.ts.
//
// The sentinel survives for one job only: fs/promises is not a repo module, so
// its mock stays inline and needs an explicit "this suite is done" signal
// before readFile may go back to real disk reads.
let useMockForSessionMemory = true

const mockGetMainLoopModel = mock(() => 'claude-opus-4-7')
const mockGetDisplayedEffortLevel = mock((): EffortLevel => 'high')

const modelMock = setupModelMock({
  getMainLoopModel: mockGetMainLoopModel,
})

const effortMock = setupEffortMock({
  getDisplayedEffortLevel: mockGetDisplayedEffortLevel,
})

const envUtilsMock = setupEnvUtilsMock({
  getClaudeConfigHomeDir: () => '/mock/home/.claude',
  getTeamsDir: () => '/mock/home/.claude/teams',
})

afterAll(() => {
  effortMock.reset()
  modelMock.reset()
  envUtilsMock.reset()
  useMockForSessionMemory = false
})

mock.module('src/utils/telemetry/log.ts', logMock)

// Mock fs/promises so loadSessionMemoryPrompt() and loadSessionMemoryTemplate()
// return our controlled templates. Once afterAll flips
// useMockForSessionMemory off, readFile delegates to the real impl so
// sibling tests in the same process (skill prefetch, skillLearning smoke)
// still see real disk reads. We must list every export the prefetch /
// skillLearning paths use so this process-global mock doesn't strip names
// to undefined.
//
// Instead of pre-importing node:fs/promises (which can interact poorly
// with bun:test mock processing), use require() at mock-factory-call time
// to fetch the real module lazily.
const mockReadFileFsPromises = mock(
  async (_path: string, _opts?: unknown): Promise<string> => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
)

mock.module('fs/promises', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:fs/promises') as Record<string, unknown>
  return {
    ...real,
    readFile: ((path: unknown, opts?: unknown) => {
      if (useMockForSessionMemory) {
        return mockReadFileFsPromises(path as string, opts)
      }
      return (real.readFile as (...a: unknown[]) => unknown)(
        path as string,
        opts,
      )
    }) as typeof real.readFile,
  }
})

// ── Import module under test (after all mock.module calls) ──────────────────
import { buildSessionMemoryUpdatePrompt } from '../prompts.js'

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildSessionMemoryUpdatePrompt – dynamic variable substitution', () => {
  beforeEach(() => {
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')
    mockGetDisplayedEffortLevel.mockReturnValue('high')
    // Default: ENOENT so the built-in default prompt is used
    mockReadFileFsPromises.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  })

  test('substitutes {{CLAUDE_MODEL}} with the current model', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return 'Model: {{CLAUDE_MODEL}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('Model: claude-opus-4-7')
    expect(result).not.toContain('{{CLAUDE_MODEL}}')
  })

  test('substitutes {{CLAUDE_EFFORT}} with the current effort level', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return 'Effort: {{CLAUDE_EFFORT}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetDisplayedEffortLevel.mockReturnValue('high')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('Effort: high')
    expect(result).not.toContain('{{CLAUDE_EFFORT}}')
  })

  test('substitutes {{CLAUDE_CWD}} with process.cwd()', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md')) return 'CWD: {{CLAUDE_CWD}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain(`CWD: ${process.cwd()}`)
    expect(result).not.toContain('{{CLAUDE_CWD}}')
  })

  test('substitutes all three dynamic variables in one template', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return 'effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}} cwd={{CLAUDE_CWD}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-sonnet-4-6')
    mockGetDisplayedEffortLevel.mockReturnValue('medium')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('effort=medium')
    expect(result).toContain('model=claude-sonnet-4-6')
    expect(result).toContain(`cwd=${process.cwd()}`)
  })

  test('leaves unknown template variables unchanged', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return '{{UNKNOWN_VAR}} {{CLAUDE_MODEL}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('{{UNKNOWN_VAR}}')
    expect(result).toContain('claude-opus-4-7')
  })

  test('existing substitution variables still work alongside new ones', async () => {
    mockReadFileFsPromises.mockImplementation(async (path: string) => {
      if ((path as string).includes('prompt.md'))
        return '{{notesPath}} effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}}'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetMainLoopModel.mockReturnValue('claude-haiku')
    mockGetDisplayedEffortLevel.mockReturnValue('low')

    const result = await buildSessionMemoryUpdatePrompt('notes', '/notes.md')
    expect(result).toContain('/notes.md')
    expect(result).toContain('effort=low')
    expect(result).toContain('model=claude-haiku')
  })
})
