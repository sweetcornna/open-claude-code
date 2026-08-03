import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOriginalCwd, setOriginalCwd } from 'src/bootstrap/state'
import { getClaudeConfigHomeDir } from '../../config/envUtils'
import { getWatchTargets } from '../changeDetector'
import { getManagedFilePath, getManagedSettingsDropInDir } from '../managedPath'

test('watches candidate parents and nearest existing ancestors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occ-settings-watch-'))
  const projectDir = join(root, 'project')
  const configDir = join(root, 'user-config')
  const managedDir = join(root, 'managed', 'nested')
  const previousConfigDir = process.env.OCC_CONFIG_DIR
  const previousManagedDir = process.env.OCC_MANAGED_SETTINGS_PATH
  const previousCwd = getOriginalCwd()

  try {
    await mkdir(projectDir)
    await mkdir(configDir)
    process.env.OCC_CONFIG_DIR = configDir
    process.env.OCC_MANAGED_SETTINGS_PATH = managedDir
    setOriginalCwd(projectDir)
    getClaudeConfigHomeDir.cache.clear?.()
    getManagedFilePath.cache.clear?.()
    getManagedSettingsDropInDir.cache.clear?.()

    const targets = await getWatchTargets()

    expect(targets.dirs).toContain(configDir)
    expect(targets.dirs).toContain(projectDir)
    expect(targets.dirs).toContain(root)
    expect(targets.settingsFiles).toContain(join(configDir, 'settings.json'))
    expect(targets.settingsFiles).toContain(
      join(projectDir, '.occ', 'settings.json'),
    )
    expect(targets.settingsFiles).toContain(
      join(projectDir, '.occ', 'settings.local.json'),
    )
    expect(targets.settingsFiles).toContain(
      join(managedDir, 'managed-settings.json'),
    )
    expect(targets.targetDirs).toContain(join(projectDir, '.occ'))
    expect(targets.targetDirs).toContain(join(managedDir, 'managed-settings.d'))
    expect(targets.depth).toBe(3)
  } finally {
    setOriginalCwd(previousCwd)
    if (previousConfigDir === undefined) {
      delete process.env.OCC_CONFIG_DIR
    } else {
      process.env.OCC_CONFIG_DIR = previousConfigDir
    }
    if (previousManagedDir === undefined) {
      delete process.env.OCC_MANAGED_SETTINGS_PATH
    } else {
      process.env.OCC_MANAGED_SETTINGS_PATH = previousManagedDir
    }
    getClaudeConfigHomeDir.cache.clear?.()
    getManagedFilePath.cache.clear?.()
    getManagedSettingsDropInDir.cache.clear?.()
    await rm(root, { recursive: true, force: true })
  }
})
