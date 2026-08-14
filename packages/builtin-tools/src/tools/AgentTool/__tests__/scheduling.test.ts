import { describe, expect, test } from 'bun:test'
import { isBackgroundRequested, shouldAgentRunAsync } from '../scheduling.js'

const base = {
  runInBackground: undefined as boolean | undefined,
  agentDefinitionBackground: undefined as boolean | undefined,
  isInProcessTeammate: false,
  forcedAsync: false,
  isBackgroundTasksDisabled: false,
}

describe('agent scheduling default', () => {
  test('omitting run_in_background runs in the background', () => {
    expect(shouldAgentRunAsync(base)).toBe(true)
    expect(isBackgroundRequested(base)).toBe(true)
  })

  test('run_in_background: false is the only foreground request', () => {
    expect(shouldAgentRunAsync({ ...base, runInBackground: false })).toBe(false)
    expect(isBackgroundRequested({ ...base, runInBackground: false })).toBe(
      false,
    )
  })

  test('run_in_background: true still runs in the background', () => {
    expect(shouldAgentRunAsync({ ...base, runInBackground: true })).toBe(true)
  })

  test('disabling background tasks forces the foreground even with the parameter omitted', () => {
    expect(
      shouldAgentRunAsync({ ...base, isBackgroundTasksDisabled: true }),
    ).toBe(false)
  })
})

describe('agent scheduling vetoes and forcing', () => {
  test('isBackgroundTasksDisabled outranks every request', () => {
    for (const runInBackground of [true, false, undefined]) {
      for (const forcedAsync of [true, false]) {
        expect(
          shouldAgentRunAsync({
            ...base,
            runInBackground,
            forcedAsync,
            agentDefinitionBackground: true,
            isBackgroundTasksDisabled: true,
          }),
        ).toBe(false)
      }
    }
  })

  test('an agent definition with background: true beats an explicit false', () => {
    expect(
      shouldAgentRunAsync({
        ...base,
        runInBackground: false,
        agentDefinitionBackground: true,
      }),
    ).toBe(true)
  })

  test('session-level forcing overrides an explicit foreground request', () => {
    expect(
      shouldAgentRunAsync({
        ...base,
        runInBackground: false,
        forcedAsync: true,
      }),
    ).toBe(true)
  })
})

describe('in-process teammates', () => {
  test('stay in the foreground when the parameter is omitted', () => {
    expect(shouldAgentRunAsync({ ...base, isInProcessTeammate: true })).toBe(
      false,
    )
    expect(isBackgroundRequested({ ...base, isInProcessTeammate: true })).toBe(
      false,
    )
  })

  test('an explicit true is still honored (the caller-facing guard rejects it earlier)', () => {
    expect(
      shouldAgentRunAsync({
        ...base,
        isInProcessTeammate: true,
        runInBackground: true,
      }),
    ).toBe(true)
  })
})
