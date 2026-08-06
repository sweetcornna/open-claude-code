import { describe, expect, test } from 'bun:test'
import { detectGate, GatedEngineError } from '../adapters/gate'

describe('detectGate', () => {
  test('returns undefined for an ordinary results page', () => {
    expect(
      detectGate(
        '<div class="result"><a href="https://example.com">Hit</a></div>',
      ),
    ).toBeUndefined()
  })

  test('returns undefined for empty input', () => {
    expect(detectGate('')).toBeUndefined()
  })

  test.each([
    ['g-recaptcha', '<div class="g-recaptcha" data-sitekey="x"></div>'],
    ['h-captcha', '<div class="h-captcha"></div>'],
    ['px-captcha', '<div id="px-captcha"></div>'],
    [
      'captcha-delivery',
      '<iframe src="https://geo.captcha-delivery.com/"></iframe>',
    ],
    [
      'google /sorry',
      '<a href="https://www.google.com/sorry/index?continue=x">',
    ],
    ['unusual traffic', '<p>Our systems have detected unusual traffic</p>'],
  ])('flags %s as a captcha gate', (_label, html) => {
    expect(detectGate(html)).toBe('captcha')
  })

  test("flags DuckDuckGo's anomaly page, which never says 'captcha'", () => {
    // The real 202 body: a modal asking the visitor to prove they are human.
    // This is the case that silently zeroed the pool's best engine.
    const html =
      '<div class="anomaly-modal__mask"><p>Select all squares containing a duck</p></div>'
    expect(html.toLowerCase()).not.toContain('captcha')
    expect(detectGate(html)).toBe('captcha')
  })

  test("flags Mojeek's ALTCHA challenge", () => {
    expect(detectGate('<div class="captcha-wrap"><altcha-widget/></div>')).toBe(
      'captcha',
    )
  })

  test('flags the Anubis interstitial public SearXNG instances sit behind', () => {
    // Both the raw and the HTML-escaped apostrophe forms appear in the wild.
    expect(detectGate("<title>Making sure you're not a bot!</title>")).toBe(
      'captcha',
    )
    expect(detectGate('<title>Making sure you&#39;re not a bot!</title>')).toBe(
      'captcha',
    )
  })

  test('flags a JS-only shell served in place of results', () => {
    expect(
      detectGate('<p>Please click here if you are not redirected</p>'),
    ).toBe('javascript')
  })

  test('flags consent and login walls', () => {
    expect(detectGate('<a href="https://consent.google.com/x">')).toBe(
      'consent',
    )
    expect(detectGate('<p>You must log in to continue</p>')).toBe('login')
  })

  test('is case-insensitive', () => {
    expect(detectGate('<DIV CLASS="G-RECAPTCHA">')).toBe('captcha')
  })

  test('prefers captcha over a lower-priority marker on the same page', () => {
    expect(
      detectGate('<div class="g-recaptcha"></div><p>sign in to continue</p>'),
    ).toBe('captcha')
  })
})

describe('GatedEngineError', () => {
  test('names the engine and the reason', () => {
    const error = new GatedEngineError('bing', 'captcha')
    expect(error).toBeInstanceOf(Error)
    expect(error.engineName).toBe('bing')
    expect(error.reason).toBe('captcha')
    expect(error.message).toContain('bing')
    expect(error.message).toContain('captcha')
  })
})
