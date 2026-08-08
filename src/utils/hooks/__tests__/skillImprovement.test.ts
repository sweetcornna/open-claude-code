import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isSkillImprovementEnabled } from '../skillImprovement.js'

/**
 * Only the two keys under test are saved and restored. Assigning a fresh object
 * to `process.env` replaces Bun's env proxy with a plain snapshot taken at
 * import time — every key any later file in this shard set, and every key set
 * after this module loaded, silently reverts with it.
 */
const TOUCHED = ['SKILL_LEARNING_ENABLED', 'SKILL_IMPROVEMENT_ENABLED'] as const
const saved: Record<string, string | undefined> = {}
for (const key of TOUCHED) saved[key] = process.env[key]

beforeEach(() => {
  for (const key of TOUCHED) delete process.env[key]
})

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('skillImprovement', () => {
  test('is enabled when skill learning is enabled', () => {
    process.env.SKILL_LEARNING_ENABLED = '1'

    expect(isSkillImprovementEnabled()).toBe(true)
  })

  test('explicit skill improvement opt-out wins', () => {
    process.env.SKILL_LEARNING_ENABLED = '1'
    process.env.SKILL_IMPROVEMENT_ENABLED = '0'

    expect(isSkillImprovementEnabled()).toBe(false)
  })
})
