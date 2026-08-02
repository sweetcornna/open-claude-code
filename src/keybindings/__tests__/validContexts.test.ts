/**
 * Ratchet: every context that ships a default binding must also be accepted by
 * the user-config validator.
 *
 * `VALID_CONTEXTS` in validate.ts is a hand-maintained allowlist. When a new
 * context block was added to DEFAULT_BINDINGS without updating that list, the
 * bindings still worked out of the box (the resolver never consults
 * VALID_CONTEXTS) but users could not *rebind* them: validateUserConfig
 * rejected the block with a severity-'error' `invalid_context` warning, so the
 * whole block was dropped. The failure was silent from the code's side and
 * only visible to a user editing keybindings.json.
 *
 * That is exactly how 'EffortPanel' regressed — 10 actions declared and
 * consumed, but unbindable. This test fails loudly the next time the two lists
 * drift apart.
 */
import { describe, expect, test } from 'bun:test'
import { DEFAULT_BINDINGS } from '../defaultBindings.js'
import { validateUserConfig } from '../validate.js'

describe('VALID_CONTEXTS covers every shipped default context', () => {
  const defaultContexts = [...new Set(DEFAULT_BINDINGS.map(b => b.context))]

  test('DEFAULT_BINDINGS declares at least the well-known contexts', () => {
    // Guards against the source list silently emptying out (e.g. a bad merge),
    // which would make the per-context assertions below vacuously pass.
    expect(defaultContexts.length).toBeGreaterThanOrEqual(20)
    expect(defaultContexts).toContain('Global')
    expect(defaultContexts).toContain('EffortPanel')
  })

  for (const context of defaultContexts) {
    test(`context "${context}" is accepted in a user keybindings.json`, () => {
      const warnings = validateUserConfig([{ context, bindings: {} }])
      const contextErrors = warnings.filter(w => w.type === 'invalid_context')
      expect(contextErrors).toEqual([])
    })
  }

  test('a genuinely unknown context is still rejected', () => {
    // Ensures the assertions above are meaningful and not passing because
    // validateUserConfig stopped checking contexts altogether.
    const warnings = validateUserConfig([
      { context: 'NotARealContext', bindings: {} },
    ])
    expect(warnings.some(w => w.type === 'invalid_context')).toBe(true)
  })
})
