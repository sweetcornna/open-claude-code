import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_DIR_NAME } from 'src/config/paths.js'

export function detectAutofixSkills(cwd: string): string[] {
  const candidates = [
    'AUTOFIX.md',
    join(PROJECT_DIR_NAME, 'skills', 'autofix.md'),
    join(PROJECT_DIR_NAME, 'skills', 'autofix-pr', 'SKILL.md'),
  ]
  return candidates.filter(rel => existsSync(join(cwd, rel)))
}

export function formatSkillsHint(skills: string[]): string {
  if (skills.length === 0) return ''
  return ` Run ${skills.join(' and ')} for custom instructions on how to autofix.`
}
