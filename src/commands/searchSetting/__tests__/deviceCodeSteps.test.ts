import { describe, expect, test } from 'bun:test'
import { deviceCodeSteps } from '../search-setting.js'

/**
 * Measured against the live server on 2026-08-11: a signed-out GET of
 * `https://auth.openai.com/codex/device` answers 302 to
 * `/api/accounts/deviceauth/authorize`, which lands on `/oauth/authorize`.
 * The code field is behind that sign-in, so the instruction order is a
 * correctness property, not a wording preference.
 */
describe('deviceCodeSteps', () => {
  const code = {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'M1G0-1YEMB',
  }

  test('asks the user to sign in before it mentions the code', () => {
    const [signIn, enterCode] = deviceCodeSteps(code)

    expect(signIn).toContain(code.verificationUrl)
    expect(signIn).not.toContain(code.userCode)
    expect(enterCode).toContain(code.userCode)
  })

  test('keeps the two actions in separate steps', () => {
    // The regression this guards is the collapse back to a single
    // "open <url> and enter <code>" line, which reads as one action and sends
    // a first-time user to type the code into the sign-in page.
    const [signIn, enterCode] = deviceCodeSteps(code)

    expect(signIn).not.toBe(enterCode)
    for (const step of [signIn, enterCode]) {
      expect(step).not.toContain(' and enter ')
    }
  })

  test('says the dash belongs to the code', () => {
    // The form supplies its own separator, so a pasted `M1G0-1YEMB` is
    // rejected on the first try.
    const [, enterCode] = deviceCodeSteps(code)

    expect(enterCode).toContain('dash')
  })
})
