import { getGlobalConfig, saveGlobalConfig } from '../config/config.js'
import { logForDebugging } from '../telemetry/debug.js'
import type { ThemeSetting } from '../terminal/themeNames.js'
import { getInitialSettings, updateSettingsForSource } from './settings.js'

function mirrorLegacyTheme(setting: ThemeSetting): void {
  saveGlobalConfig(current =>
    current.theme === setting ? current : { ...current, theme: setting },
  )
}

export function loadAndSyncThemeSetting(): ThemeSetting {
  const setting = getInitialSettings().theme ?? getGlobalConfig().theme
  mirrorLegacyTheme(setting)
  return setting
}

export function persistThemeSetting(setting: ThemeSetting): void {
  const { error } = updateSettingsForSource('userSettings', { theme: setting })
  if (error) {
    logForDebugging(`Failed to persist theme: ${error.message}`, {
      level: 'error',
    })
    return
  }
  mirrorLegacyTheme(setting)
}
