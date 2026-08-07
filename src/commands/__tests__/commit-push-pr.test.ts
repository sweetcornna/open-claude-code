import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { Command } from '../../commands.js'
import { setupUndercoverMock } from '../../../tests/mocks/undercover.js'
import { setupPromptShellExecutionMock } from '../../../tests/mocks/promptShellExecution.js'
import { setupGitAttributionMock } from '../../../tests/mocks/gitAttribution.js'
import { setupGitMock } from '../../../tests/mocks/git.js'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))

const attributionMock = setupGitAttributionMock({
  getAttributionTexts: () => ({ commit: '', pr: '' }),
  getEnhancedPRAttribution: async () => '',
  countUserPromptsInMessages: () => 0,
})
afterAll(() => attributionMock.reset())

const undercoverMock = setupUndercoverMock({
  isUndercover: () => false,
  getUndercoverInstructions: () => '',
  shouldShowUndercoverAutoNotice: () => false,
})
afterAll(() => undercoverMock.reset())

const shellPromptMock = setupPromptShellExecutionMock({
  executeShellCommandsInPrompt: async (content: string) => content,
})
afterAll(() => shellPromptMock.reset())

// The suite asserts the generated prompt names the default branch. Everything
// else in git.js delegates to the real module, so pure helpers keep their real
// semantics for whatever file Bun loads next in this shard.
const gitMock = setupGitMock({
  getDefaultBranch: async () => 'main',
})
afterAll(() => gitMock.reset())

let commitPushPr: Command
let originalUserType: string | undefined
let originalSafeUser: string | undefined
let originalUser: string | undefined

beforeEach(async () => {
  originalUserType = process.env.USER_TYPE
  originalSafeUser = process.env.SAFEUSER
  originalUser = process.env.USER
  const mod = await import('../commit-push-pr.js')
  commitPushPr = mod.default as Command
})

afterEach(() => {
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType

  if (originalSafeUser === undefined) delete process.env.SAFEUSER
  else process.env.SAFEUSER = originalSafeUser

  if (originalUser === undefined) delete process.env.USER
  else process.env.USER = originalUser
})

describe('commit-push-pr command metadata', () => {
  test('has correct name', () => {
    expect(commitPushPr.name).toBe('commit-push-pr')
  })

  test('has description', () => {
    expect(commitPushPr.description).toBeTruthy()
    expect(typeof commitPushPr.description).toBe('string')
  })

  test('type is prompt', () => {
    expect(commitPushPr.type).toBe('prompt')
  })

  test('has progressMessage', () => {
    expect((commitPushPr as any).progressMessage).toBeTruthy()
  })

  test('source is builtin', () => {
    expect((commitPushPr as any).source).toBe('builtin')
  })

  test('has allowedTools array with git and gh tools', () => {
    const tools = (commitPushPr as any).allowedTools as string[]
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.some(t => t.includes('git push'))).toBe(true)
    expect(tools.some(t => t.includes('gh pr create'))).toBe(true)
    expect(tools.some(t => t.includes('git add'))).toBe(true)
    expect(tools.some(t => t.includes('git commit'))).toBe(true)
  })

  test('contentLength getter returns a number', () => {
    const len = (commitPushPr as any).contentLength
    expect(typeof len).toBe('number')
    expect(len).toBeGreaterThan(0)
  })
})

describe('commit-push-pr getPromptForCommand', () => {
  const makeContext = () => ({
    getAppState: () => ({
      toolPermissionContext: {
        alwaysAllowRules: { command: [] },
      },
    }),
  })

  test('returns array with text type for empty args', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].type).toBe('text')
  })

  test('result text contains pull request instructions', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('PR')
  })

  test('result text contains default branch', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('main')
  })

  test('appends additional user instructions when args provided', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      'Fix the bug',
      makeContext(),
    )
    expect(result[0].text).toContain('Fix the bug')
    expect(result[0].text).toContain('Additional instructions')
  })

  test('does not append additional instructions section for whitespace-only args', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '   ',
      makeContext(),
    )
    expect(result[0].text).not.toContain('Additional instructions')
  })

  test('handles null/undefined args gracefully', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      undefined,
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].type).toBe('text')
  })

  test('does not request the official Anthropic reviewer', async () => {
    process.env.USER_TYPE = 'external'
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('gh pr create')
    expect(result[0].text).not.toContain('anthropics/claude-code')
    expect(result[0].text).not.toContain('--reviewer')
    expect(result[0].text).not.toContain('--add-reviewer')
  })

  test('with SAFEUSER env var set, text contains context', async () => {
    process.env.SAFEUSER = 'testuser'
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('SAFEUSER')
  })

  test('with ant user type and undercover, strips reviewer args', async () => {
    process.env.USER_TYPE = 'ant'
    // isUndercover is mocked as false, so no prefix should be added
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
  })

  test('with args containing newlines, appends full multi-line instructions', async () => {
    const multiline = 'Line one\nLine two\nLine three'
    const result = await (commitPushPr as any).getPromptForCommand(
      multiline,
      makeContext(),
    )
    expect(result[0].text).toContain('Line one')
    expect(result[0].text).toContain('Line three')
  })

  test('getAppState override in context includes ALLOWED_TOOLS', async () => {
    let capturedGetAppState: (() => any) | undefined

    // Re-mock executeShellCommandsInPrompt to capture the context argument
    shellPromptMock.set({
      executeShellCommandsInPrompt: async (content: string, ctx: any) => {
        capturedGetAppState = ctx.getAppState.bind(ctx)
        return content
      },
    })
    // Re-import to pick up the new mock
    const { default: freshCmd } = await import('../commit-push-pr.js')

    await (freshCmd as any).getPromptForCommand('', {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: ['pre-existing'] },
          extra: true,
        },
        someState: 'value',
      }),
    })

    expect(capturedGetAppState).toBeDefined()
    const resultState = capturedGetAppState!()
    expect(
      Array.isArray(resultState.toolPermissionContext.alwaysAllowRules.command),
    ).toBe(true)
    // Should have replaced with ALLOWED_TOOLS
    expect(
      resultState.toolPermissionContext.alwaysAllowRules.command.length,
    ).toBeGreaterThan(0)
    expect(resultState.someState).toBe('value')
  })

  test('ant undercover path strips reviewer/slack/changelog sections', async () => {
    process.env.USER_TYPE = 'ant'

    // Re-mock undercover to return true for this test
    undercoverMock.set({
      isUndercover: () => true,
      getUndercoverInstructions: () => 'UNDERCOVER_INSTRUCTIONS',
      shouldShowUndercoverAutoNotice: () => false,
    })
    // Also re-mock attribution to return commit text
    attributionMock.set({
      getAttributionTexts: () => ({
        commit: 'Attribution text',
        pr: 'PR Attribution',
      }),
      getEnhancedPRAttribution: async () => 'Enhanced PR Attribution',
      countUserPromptsInMessages: () => 0,
    })
    const { default: freshCmd } = await import('../commit-push-pr.js')

    const result = await (freshCmd as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
    // The undercover path removes slackStep, changelogSection, and reviewer args
    // The prompt should not contain those sections
    expect(result[0].text).not.toContain('CHANGELOG:START')
    expect(result[0].text).not.toContain('Slack')
  })
})
