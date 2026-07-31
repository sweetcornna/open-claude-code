import { describe, expect, test } from 'bun:test'
import { SYNC_KEYS } from '../types.js'

describe('SYNC_KEYS', () => {
  test('materializes all remote keys inside the occ namespace', () => {
    const projectId = 'project-id'

    expect([
      SYNC_KEYS.USER_SETTINGS,
      SYNC_KEYS.USER_MEMORY,
      SYNC_KEYS.projectSettings(projectId),
      SYNC_KEYS.projectMemory(projectId),
    ]).toEqual([
      '~/.occ/settings.json',
      '~/.occ/CLAUDE.md',
      'projects/project-id/.occ/settings.local.json',
      'projects/project-id/.occ/CLAUDE.local.md',
    ])
  })
})
