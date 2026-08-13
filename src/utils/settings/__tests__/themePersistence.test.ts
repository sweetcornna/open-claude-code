import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import {
  setThemeConfigCallbacks,
  ThemeProvider,
  useTheme,
  wrappedRender,
} from '@anthropic/ink'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../../bootstrap/state.js'
import { occConfigDir } from '../../../config/paths.js'
import { getGlobalConfig, saveGlobalConfig } from '../../config/config.js'
import { getSettingsForSource, updateSettingsForSource } from '../settings.js'
import { resetSettingsCache } from '../settingsCache.js'
import {
  loadAndSyncThemeSetting,
  persistThemeSetting,
} from '../themePersistence.js'
import type { ThemeSetting } from '../../terminal/themeNames.js'

let root: string | null = null
let previousConfigDir: string | undefined
let previousCwd: string
let previousOriginalCwd: string
let previousGlobalTheme: ThemeSetting

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'occ-theme-settings-'))
  previousConfigDir = process.env.OCC_CONFIG_DIR
  previousCwd = getCwdState()
  previousOriginalCwd = getOriginalCwd()
  previousGlobalTheme = getGlobalConfig().theme

  const configDir = join(root, 'config')
  const projectDir = join(root, 'project')
  await mkdir(configDir)
  await mkdir(projectDir)
  process.env.OCC_CONFIG_DIR = configDir
  setCwdState(projectDir)
  setOriginalCwd(projectDir)
  occConfigDir.cache.clear?.()
  resetSettingsCache()
})

afterEach(async () => {
  setThemeConfigCallbacks({ loadTheme: () => 'dark', saveTheme: () => {} })
  saveGlobalConfig(current =>
    current.theme === previousGlobalTheme
      ? current
      : { ...current, theme: previousGlobalTheme },
  )
  if (previousConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = previousConfigDir
  setCwdState(previousCwd)
  setOriginalCwd(previousOriginalCwd)
  occConfigDir.cache.clear?.()
  resetSettingsCache()
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

function setGlobalTheme(theme: ThemeSetting): void {
  saveGlobalConfig(current =>
    current.theme === theme ? current : { ...current, theme },
  )
}

describe('theme settings persistence', () => {
  test('prefers settings.json and synchronizes legacy global consumers', async () => {
    setGlobalTheme('dark')
    await writeFile(
      join(occConfigDir(), 'settings.json'),
      '{"theme":"light"}\n',
    )
    resetSettingsCache()

    expect(loadAndSyncThemeSetting()).toBe('light')
    expect(getGlobalConfig().theme).toBe('light')
  })

  test('ThemeProvider persists picker updates through the production callbacks', async () => {
    await writeFile(
      join(occConfigDir(), 'settings.json'),
      '{"theme":"light"}\n',
    )
    resetSettingsCache()
    setThemeConfigCallbacks({
      loadTheme: loadAndSyncThemeSetting,
      saveTheme: persistThemeSetting,
    })

    let applyTheme: ReturnType<typeof useTheme>[1] = () => {
      throw new Error('ThemeProvider did not render')
    }
    function Probe(): React.ReactNode {
      const [theme, setter] = useTheme()
      applyTheme = setter
      return React.createElement('ink-text', null, theme)
    }

    const output = new PassThrough()
    output.resume()
    const input = new PassThrough()
    const instance = await wrappedRender(
      React.createElement(ThemeProvider, null, React.createElement(Probe)),
      {
        stdout: output as unknown as NodeJS.WriteStream,
        stdin: input as unknown as NodeJS.ReadStream,
        stderr: output as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )

    try {
      applyTheme('auto')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(getSettingsForSource('userSettings')?.theme).toBe('auto')
      expect(getGlobalConfig().theme).toBe('auto')
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })

  test('does not mirror a theme when user settings cannot be written', async () => {
    const settingsPath = join(occConfigDir(), 'settings.json')
    await writeFile(settingsPath, '{"theme":')
    resetSettingsCache()
    setGlobalTheme('dark')

    persistThemeSetting('light')

    expect(getGlobalConfig().theme).toBe('dark')
    expect(await readFile(settingsPath, 'utf8')).toBe('{"theme":')
  })

  test('rollback removes a user theme that was initially absent', () => {
    setGlobalTheme('dark')
    const initialTheme = loadAndSyncThemeSetting()
    const initialUserTheme = getSettingsForSource('userSettings')?.theme

    persistThemeSetting('light')
    persistThemeSetting(initialTheme)
    expect(
      updateSettingsForSource('userSettings', { theme: initialUserTheme })
        .error,
    ).toBeNull()

    expect(getSettingsForSource('userSettings')?.theme).toBeUndefined()
    expect(getGlobalConfig().theme).toBe('dark')
  })
})
