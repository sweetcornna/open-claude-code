import { describe, expect, test } from 'bun:test'
import {
  planSessionTitleAttempt,
  sessionTitleGateAfterAttempt,
  type SessionTitlePlanInput,
} from '../sessionTitleGate.js'

const base: SessionTitlePlanInput = {
  disabled: false,
  existingTitle: undefined,
  agentTitle: undefined,
  attempted: false,
  text: 'fix the login button on mobile',
}

/**
 * Drive the gate the way REPL.tsx drives it: plan an attempt per turn, spend
 * the gate when one is planned, then fold the settled result back in.
 * `results` supplies what `generateSessionTitle` resolved to each time it
 * was actually called (it swallows its own errors and returns null).
 */
function runTurns(turns: number, result: string | null): string[] {
  let attempted = false
  const attempts: string[] = []
  for (let i = 0; i < turns; i++) {
    const text = planSessionTitleAttempt({ ...base, attempted })
    if (text === null) continue
    attempts.push(text)
    attempted = true
    attempted = sessionTitleGateAfterAttempt(attempted, result)
  }
  return attempts
}

describe('planSessionTitleAttempt', () => {
  test('titles from the first real user message', () => {
    expect(planSessionTitleAttempt(base)).toBe('fix the login button on mobile')
  })

  test('skips when the terminal title is disabled', () => {
    expect(planSessionTitleAttempt({ ...base, disabled: true })).toBeNull()
  })

  test('skips when /rename or resume already set a title', () => {
    expect(
      planSessionTitleAttempt({ ...base, existingTitle: 'Ship the fix' }),
    ).toBeNull()
  })

  test('skips when a main-thread agent owns the title', () => {
    expect(
      planSessionTitleAttempt({ ...base, agentTitle: 'code-reviewer' }),
    ).toBeNull()
  })

  test('skips when there is no human text this turn', () => {
    expect(planSessionTitleAttempt({ ...base, text: null })).toBeNull()
    expect(planSessionTitleAttempt({ ...base, text: '' })).toBeNull()
  })

  test.each([
    '<local-command-stdout>Login successful</local-command-stdout>',
    '<command-message>commit</command-message>',
    '<command-name>/help</command-name>',
    '<bash-input>git status</bash-input>',
  ])('skips synthetic breadcrumb %s', breadcrumb => {
    expect(planSessionTitleAttempt({ ...base, text: breadcrumb })).toBeNull()
  })

  test('skips once the gate has been spent', () => {
    expect(planSessionTitleAttempt({ ...base, attempted: true })).toBeNull()
  })
})

describe('session title one-shot', () => {
  test('a successful attempt is made exactly once', () => {
    expect(runTurns(5, 'Fix the login button')).toEqual([
      'fix the login button on mobile',
    ])
  })

  // Regression: `generateSessionTitle` returns null for every failure it
  // swallows (401, unknown haiku-tier model, endpoint that rejects
  // json_schema). The gate used to re-arm on null, so on such a provider
  // EVERY prompt fired the title side query on top of the main loop — two
  // API requests per user message, forever. Re-arming turns this into 5.
  test('a failed attempt does not re-arm the one-shot', () => {
    expect(runTurns(5, null)).toEqual(['fix the login button on mobile'])
  })

  test('the gate stays spent regardless of the settled result', () => {
    expect(sessionTitleGateAfterAttempt(true, null)).toBe(true)
    expect(sessionTitleGateAfterAttempt(true, 'A title')).toBe(true)
  })
})
