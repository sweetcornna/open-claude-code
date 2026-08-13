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
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXTS,
  KeybindingsSchema,
} from '../schema.js'
import {
  clearBundledSkills,
  getBundledSkills,
} from '../../skills/bundledSkills.js'
import { registerKeybindingsSkill } from '../../skills/bundled/keybindings.js'
import { validateUserConfig } from '../validate.js'

describe('keybinding schemas cover every shipped default', () => {
  const defaultContexts = [...new Set(DEFAULT_BINDINGS.map(b => b.context))]
  const defaultActions = [
    ...new Set(
      DEFAULT_BINDINGS.flatMap(block =>
        Object.values(block.bindings).filter(
          (action): action is string => action !== null,
        ),
      ),
    ),
  ]

  test('DEFAULT_BINDINGS declares at least the well-known contexts', () => {
    // Guards against the source list silently emptying out (e.g. a bad merge),
    // which would make the per-context assertions below vacuously pass.
    expect(defaultContexts.length).toBeGreaterThanOrEqual(20)
    expect(defaultContexts).toContain('Global')
    expect(defaultContexts).toContain('EffortPanel')
  })

  test('schema lists every default context and action', () => {
    expect(
      defaultContexts.filter(
        context =>
          !(KEYBINDING_CONTEXTS as readonly string[]).includes(context),
      ),
    ).toEqual([])
    expect(
      defaultActions.filter(
        action => !(KEYBINDING_ACTIONS as readonly string[]).includes(action),
      ),
    ).toEqual([])
  })

  test('the public schema accepts all default binding blocks', () => {
    expect(
      KeybindingsSchema().safeParse({ bindings: DEFAULT_BINDINGS }).success,
    ).toBe(true)
  })

  test('the keybindings-help prompt lists every default action', async () => {
    clearBundledSkills()
    try {
      registerKeybindingsSkill()
      const skill = getBundledSkills().find(
        command => command.name === 'keybindings-help',
      )
      expect(skill?.type).toBe('prompt')
      if (!skill || skill.type !== 'prompt') return

      const blocks = await skill.getPromptForCommand('', {} as never)
      const prompt = blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      for (const action of defaultActions) {
        expect(prompt).toContain(`\`${action}\``)
      }
    } finally {
      clearBundledSkills()
    }
  })

  for (const context of defaultContexts) {
    test(`context "${context}" is accepted by runtime validation`, () => {
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
