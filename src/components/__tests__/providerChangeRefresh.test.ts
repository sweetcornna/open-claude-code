/**
 * Every path that reconfigures the provider has to tell the session.
 *
 * The shared setup wizard has done this since it was introduced; the three
 * OAuth flows next to it did not. They wrote settings and env, then called
 * `onDone()` — so AppState kept the settings snapshot and the already resolved
 * main-loop model from before the login, and the user's only fix was to
 * restart occ. The symptom ("I logged in and nothing changed") reads like a
 * broken login, which is why it survived three separate flows.
 *
 * Pinned by reading the source rather than by rendering: reaching those code
 * paths means a device-code round trip, a browser, a loopback server and the
 * keychain, and Ink's test mode does not pump the concurrent state updates
 * that would be needed either (see MigrationStep.test.tsx). The assertions are
 * anchored on what each flow *does* — the auth mode it writes, the env builder
 * it calls — so they cannot be satisfied by the identifier appearing anywhere
 * else in the file.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const sourceRoot = resolve(import.meta.dir, '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
}

describe('the OAuth login flows refresh the session', () => {
  const source = readSource('components/ConsoleOAuthFlow.tsx')

  test('Claude.ai / Console OAuth notifies after resetting modelType', () => {
    expect(source).toMatch(
      /modelType: 'anthropic'[\s\S]{0,600}?onProviderChangedRef\.current\?\.\(\{\s*modelType: 'anthropic'/,
    )
  })

  test('the ChatGPT subscription flow notifies after writing its auth mode', () => {
    expect(source).toMatch(
      /OPENAI_AUTH_MODE: 'chatgpt'[\s\S]{0,2500}?onProviderChanged\?\.\(\{ modelType: 'openai'/,
    )
  })

  test('the Antigravity flow notifies after writing its auto-configuration', () => {
    expect(source).toMatch(
      /buildAntigravityAutoConfigEnv\(\)[\s\S]{0,2500}?onProviderChanged\?\.\(\{ modelType: 'gemini'/,
    )
  })

  test('both sub-flows are actually handed the callback', () => {
    // They are separate components, so the notification above is dead code
    // unless the switch passes the prop down.
    for (const component of [
      'ChatGPTSubscriptionSetup',
      'AntigravityOAuthSetup',
    ]) {
      expect(source).toMatch(
        new RegExp(
          `<${component}[\\s\\S]{0,400}?onProviderChanged=\\{onProviderChanged\\}`,
        ),
      )
    }
  })

  test('the shared wizard forwards its outcome rather than discarding it', () => {
    expect(source).toMatch(
      /onSaved=\{outcome =>[\s\S]{0,200}?onProviderChanged\?\.\(outcome\)/,
    )
  })
})

describe('a save only drops the in-session model when it has to', () => {
  // A tier alias re-resolves on every request, so an effort / context /
  // tier-mapping edit leaves a `/model` choice perfectly valid. Clearing it
  // unconditionally meant someone who opened the form to nudge thinking effort
  // came back on a different model.
  test.each([
    ['commands/models/models.tsx'],
    ['commands/login/login.tsx'],
  ])('%s gates the reset on the outcome', relativePath => {
    const source = readSource(relativePath)
    expect(source).toMatch(
      /\.\.\.\(outcome\.providerChanged \? \{ mainLoopModel: null, mainLoopModelForSession: null \} : \{\}\)/,
    )
    // And there is no second, ungated path that undoes the gate.
    expect(source.match(/mainLoopModel: null/g)).toHaveLength(1)
  })
})
