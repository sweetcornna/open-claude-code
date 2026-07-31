import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { PROJECT_DIR_NAME } from 'src/config/paths.js'
import { getSkillsPath } from '../loadSkillsDir.js'

describe('getSkillsPath', () => {
  test('uses the occ project directory for project skills', () => {
    expect(getSkillsPath('projectSettings', 'skills')).toBe(
      join(PROJECT_DIR_NAME, 'skills'),
    )
  })

  test('uses the occ project directory for project commands', () => {
    expect(getSkillsPath('projectSettings', 'commands')).toBe(
      join(PROJECT_DIR_NAME, 'commands'),
    )
  })
})
