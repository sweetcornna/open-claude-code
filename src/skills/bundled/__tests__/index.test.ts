import { afterEach, describe, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../../bundledSkills.js'
import { initBundledSkills } from '../index.js'

afterEach(() => {
  clearBundledSkills()
})

describe('initBundledSkills', () => {
  // Writing a bundled skill file and forgetting the call here registers
  // nothing: the skill exists in the tree and is unreachable from every
  // surface. Pin the ones that are not feature-gated.
  test.each([
    'explain-usage',
    'fewer-permission-prompts',
  ])('wires %s into the registry', name => {
    clearBundledSkills()
    initBundledSkills()
    expect(getBundledSkills().map(s => s.name)).toContain(name)
  })

  test('registers each skill name at most once', () => {
    clearBundledSkills()
    initBundledSkills()
    const names = getBundledSkills().map(s => s.name)
    expect(names.length).toBe(new Set(names).size)
  })
})
