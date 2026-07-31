import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_DIR_NAME } from 'src/config/paths.js'
import { detectAutofixSkills, formatSkillsHint } from '../skillDetect.js'

describe('detectAutofixSkills', () => {
  test('detects project skills only under the occ project directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'occ-autofix-skills-'))
    const occSkill = join(
      cwd,
      PROJECT_DIR_NAME,
      'skills',
      'autofix-pr',
      'SKILL.md',
    )
    const legacySkill = join(cwd, '.claude', 'skills', 'autofix.md')

    try {
      await mkdir(join(occSkill, '..'), { recursive: true })
      await mkdir(join(legacySkill, '..'), { recursive: true })
      await writeFile(occSkill, 'occ skill')
      await writeFile(legacySkill, 'official skill')

      expect(detectAutofixSkills(cwd)).toEqual([
        join(PROJECT_DIR_NAME, 'skills', 'autofix-pr', 'SKILL.md'),
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('keeps the root AUTOFIX.md convention', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'occ-autofix-root-'))

    try {
      await writeFile(join(cwd, 'AUTOFIX.md'), 'instructions')
      expect(detectAutofixSkills(cwd)).toEqual(['AUTOFIX.md'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('formatSkillsHint', () => {
  test('formats detected skill paths', () => {
    expect(formatSkillsHint(['AUTOFIX.md', '.occ/skills/autofix.md'])).toBe(
      ' Run AUTOFIX.md and .occ/skills/autofix.md for custom instructions on how to autofix.',
    )
  })
})
