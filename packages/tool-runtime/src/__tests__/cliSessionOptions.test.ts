import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAppendSubagentSystemPrompt,
  getCliSessionOptions,
  getPlanModeInstructionsOverride,
  resetCliSessionOptions,
  setCliSessionOptions,
  shouldForwardSubagentText,
} from '../cliSessionOptions.js'

afterEach(() => {
  resetCliSessionOptions()
  delete process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT
})

describe('cliSessionOptions', () => {
  test('everything is off by default', () => {
    expect(shouldForwardSubagentText()).toBe(false)
    expect(getAppendSubagentSystemPrompt()).toBeUndefined()
    expect(getPlanModeInstructionsOverride()).toBeUndefined()
  })

  test('setCliSessionOptions merges rather than replaces', () => {
    setCliSessionOptions({ forwardSubagentText: true })
    setCliSessionOptions({ planModeInstructions: 'do the thing' })
    expect(getCliSessionOptions()).toEqual({
      forwardSubagentText: true,
      appendSubagentSystemPrompt: undefined,
      planModeInstructions: 'do the thing',
    })
  })

  test('the subagent addendum stays inert without the env gate', () => {
    setCliSessionOptions({ appendSubagentSystemPrompt: 'be terse' })
    expect(getAppendSubagentSystemPrompt()).toBeUndefined()

    process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT = '1'
    expect(getAppendSubagentSystemPrompt()).toBe('be terse')
  })

  test('the env gate only accepts truthy spellings', () => {
    setCliSessionOptions({ appendSubagentSystemPrompt: 'be terse' })
    for (const value of ['0', 'false', 'off', '']) {
      process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT = value
      expect(getAppendSubagentSystemPrompt()).toBeUndefined()
    }
    for (const value of ['1', 'true', 'YES', ' on ']) {
      process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT = value
      expect(getAppendSubagentSystemPrompt()).toBe('be terse')
    }
  })

  test('an empty plan-mode override reads as unset', () => {
    setCliSessionOptions({ planModeInstructions: '' })
    expect(getPlanModeInstructionsOverride()).toBeUndefined()
  })

  test('reset restores the defaults', () => {
    setCliSessionOptions({
      forwardSubagentText: true,
      planModeInstructions: 'x',
    })
    resetCliSessionOptions()
    expect(shouldForwardSubagentText()).toBe(false)
    expect(getPlanModeInstructionsOverride()).toBeUndefined()
  })
})
