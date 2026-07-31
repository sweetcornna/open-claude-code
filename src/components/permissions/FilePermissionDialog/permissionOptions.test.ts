import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { getGlobalOccFolderPermissionPattern } from '@open-claude-code/builtin-tools/tools/FileEditTool/constants.js'
import { PROJECT_DIR_NAME, occConfigDir } from '../../../config/paths.js'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { isInGlobalOccFolder, isInOccFolder } from './permissionOptions.js'

const originalOccConfigDir = process.env.OCC_CONFIG_DIR

afterEach(() => {
  if (originalOccConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = originalOccConfigDir
  }
  occConfigDir.cache.clear?.()
})

describe('occ config permission scopes', () => {
  test('recognizes the project occ directory', () => {
    expect(
      isInOccFolder(join(getOriginalCwd(), PROJECT_DIR_NAME, 'settings.json')),
    ).toBe(true)
    expect(
      isInOccFolder(join(getOriginalCwd(), '.claude', 'settings.json')),
    ).toBe(false)
  })

  test('recognizes and targets an OCC_CONFIG_DIR override', () => {
    process.env.OCC_CONFIG_DIR = '/tmp/custom-occ-config'
    occConfigDir.cache.clear?.()

    expect(isInGlobalOccFolder('/tmp/custom-occ-config/settings.json')).toBe(
      true,
    )
    expect(getGlobalOccFolderPermissionPattern()).toBe(
      '//tmp/custom-occ-config/**',
    )
  })
})
