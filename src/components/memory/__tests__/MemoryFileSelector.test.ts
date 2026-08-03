import { expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { getUserMemoryDescription } from '../MemoryFileSelector.js'

test('describes user memory using its actual occ configuration path', () => {
  const userMemoryPath = join(homedir(), '.occ', 'CLAUDE.md')
  const description = getUserMemoryDescription(userMemoryPath)

  expect(description).toBe('Saved in ~/.occ/CLAUDE.md')
  expect(description).not.toContain('~/.claude/')
})
