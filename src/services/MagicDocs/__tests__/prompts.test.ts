import { afterAll, describe, test, expect, mock, beforeEach } from 'bun:test'
import { setupEffortMock } from '../../../../tests/mocks/effort.js'
import { setupEnvUtilsMock } from '../../../../tests/mocks/envUtils.js'
import { setupModelMock } from '../../../../tests/mocks/model.js'
import type { EffortLevel } from 'src/utils/model/effort.js'
import {
  type FsOperations,
  NodeFsOperations,
  setFsImplementation,
  setOriginalFsImplementation,
} from 'src/utils/filesystem/fsOperations.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Mock infrastructure ─────────────────────────────────────────────────────
// All mock.module calls must precede the import of the module under test.
// mock.module is process-global, so every mock here goes through a shared
// complete-surface helper in tests/mocks/: non-overridden exports delegate to
// the real module, and afterAll drops this suite's overrides for the rest of
// the process. This file previously hand-rolled model.js and effort.js (~28
// and ~20 entries) with re-implemented copies of getDefaultOpusModel and
// firstPartyNameToCanonical, gated behind a sentinel flag so sibling suites
// would still see approximately-real behaviour. The helpers make that
// machinery unnecessary — see tests/mocks/sharedModuleMock.ts.
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
})

// Mock the file system so loadMagicDocsPrompt() returns our controlled template
const mockReadFile = mock(
  async (_path: string, _opts?: unknown): Promise<string> => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
)

// The filesystem override goes through fsOperations' OWN setter rather than
// mock.module. That matters twice over.
//
// This file first mocked fsOperations wholesale (readdir → [], exists → false,
// …), which silently broke sibling tests that walk .claude/skills. The next
// attempt hand-rolled a "real" adapter to install once this suite finished —
// but a hand-rolled adapter is a partial surface by construction, and it was
// missing the *Sync methods. Anything loaded later in the src/services shard
// that reached getFsImplementation().mkdirSync() got a TypeError:
// updateSettingsForSource swallowed it and returned an error, so
// plugins/__tests__/pluginOperations.builtinSecurity.test.ts failed with
// success:false. That was the CI failure on v2.29.4, and macOS never saw it
// because Bun's file order differs from Linux.
//
// setFsImplementation/setOriginalFsImplementation avoid the whole class: the
// base is the real NodeFsOperations, so no method can be missing, and the
// restore is the module's own reset rather than a replica.
// Only readFile is overridden: it is the one operation this suite controls
// (loadMagicDocsPrompt reads the template through it). The previous surface
// also stubbed writeFile/exists/mkdir/readdir/stat/unlink — writeFile and
// exists are not even on FsOperations, which the blanket `as unknown` cast
// hid. Everything else stays real.
const magicDocsFs: FsOperations = {
  ...NodeFsOperations,
  readFile: mockReadFile as unknown as FsOperations['readFile'],
}
setFsImplementation(magicDocsFs)
afterAll(() => setOriginalFsImplementation())

// ── Import module under test (after all mock.module calls) ──────────────────
import { buildMagicDocsUpdatePrompt } from '../prompts.js'

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildMagicDocsUpdatePrompt – dynamic variable substitution', () => {
  beforeEach(() => {
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')
    mockGetDisplayedEffortLevel.mockReturnValue('high')
    mockReadFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  })

  test('substitutes {{CLAUDE_MODEL}} with the current model', async () => {
    mockReadFile.mockImplementation(async () => 'Model: {{CLAUDE_MODEL}}')
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')

    const result = await buildMagicDocsUpdatePrompt(
      'contents',
      '/doc.md',
      'Title',
    )
    expect(result).toContain('Model: claude-opus-4-7')
    expect(result).not.toContain('{{CLAUDE_MODEL}}')
  })

  test('substitutes {{CLAUDE_EFFORT}} with the current effort level', async () => {
    mockReadFile.mockImplementation(async () => 'Effort: {{CLAUDE_EFFORT}}')
    mockGetDisplayedEffortLevel.mockReturnValue('high')

    const result = await buildMagicDocsUpdatePrompt(
      'contents',
      '/doc.md',
      'Title',
    )
    expect(result).toContain('Effort: high')
    expect(result).not.toContain('{{CLAUDE_EFFORT}}')
  })

  test('substitutes {{CLAUDE_CWD}} with process.cwd()', async () => {
    mockReadFile.mockImplementation(async () => 'CWD: {{CLAUDE_CWD}}')

    const result = await buildMagicDocsUpdatePrompt(
      'contents',
      '/doc.md',
      'Title',
    )
    expect(result).toContain(`CWD: ${process.cwd()}`)
    expect(result).not.toContain('{{CLAUDE_CWD}}')
  })

  test('substitutes all three dynamic variables in one template', async () => {
    mockReadFile.mockImplementation(
      async () =>
        'effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}} cwd={{CLAUDE_CWD}}',
    )
    mockGetMainLoopModel.mockReturnValue('claude-sonnet-4-6')
    mockGetDisplayedEffortLevel.mockReturnValue('medium')

    const result = await buildMagicDocsUpdatePrompt(
      'contents',
      '/doc.md',
      'Title',
    )
    expect(result).toContain('effort=medium')
    expect(result).toContain('model=claude-sonnet-4-6')
    expect(result).toContain(`cwd=${process.cwd()}`)
  })

  test('leaves unknown template variables unchanged', async () => {
    mockReadFile.mockImplementation(
      async () => '{{UNKNOWN_VAR}} {{CLAUDE_MODEL}}',
    )
    mockGetMainLoopModel.mockReturnValue('claude-opus-4-7')

    const result = await buildMagicDocsUpdatePrompt(
      'contents',
      '/doc.md',
      'Title',
    )
    expect(result).toContain('{{UNKNOWN_VAR}}')
    expect(result).toContain('claude-opus-4-7')
  })

  test('existing substitution variables still work alongside new ones', async () => {
    mockReadFile.mockImplementation(
      async () =>
        '{{docTitle}} effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}}',
    )
    mockGetMainLoopModel.mockReturnValue('claude-haiku')
    mockGetDisplayedEffortLevel.mockReturnValue('low')

    const result = await buildMagicDocsUpdatePrompt(
      'contents',
      '/doc.md',
      'My Doc',
    )
    expect(result).toContain('My Doc')
    expect(result).toContain('effort=low')
    expect(result).toContain('model=claude-haiku')
  })
})
