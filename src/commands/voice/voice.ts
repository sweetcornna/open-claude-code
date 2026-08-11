import { normalizeLanguageForSTT } from '../../hooks/useVoice.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config/config.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isVoiceAvailable } from '../../voice/voiceModeEnabled.js'

const LANG_HINT_MAX_SHOWS = 2

/**
 * Microphone pre-flight for the local backend.
 *
 * Deliberately a separate function rather than a refactor of the toggle-ON
 * path below: that path interleaves an Anthropic-only credential check
 * between these three probes, and the two existing backends must keep
 * behaving exactly as they did. Returns a message to show the user, or
 * null when recording is usable.
 */
async function checkMicrophonePreflight(): Promise<{
  type: 'text'
  value: string
} | null> {
  const {
    checkRecordingAvailability,
    checkVoiceDependencies,
    requestMicrophonePermission,
  } = await import('../../services/voice.js')

  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? 'Voice mode is not available in this environment.',
    }
  }

  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `\nInstall audio recording tools? Run: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording.'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  if (!(await requestMicrophonePermission())) {
    let guidance: string
    if (process.platform === 'win32') {
      guidance = 'Settings → Privacy → Microphone'
    } else if (process.platform === 'linux') {
      guidance = "your system's audio settings"
    } else {
      guidance = 'System Settings → Privacy & Security → Microphone'
    }
    return {
      type: 'text' as const,
      value: `Microphone access is denied. To enable it, go to ${guidance}, then run /voice local again.`,
    }
  }

  return null
}

/**
 * Enable (or report on) the offline backend.
 *
 * The artifacts are hundreds of megabytes, so this never blocks: a missing
 * install is started in the background and the command returns what is
 * being fetched and how big it is. Running `/voice local` again reports
 * progress. Everything is lazy-imported — the catalog and installer must
 * not be pulled into the startup graph for sessions that never dictate.
 */
async function handleLocalBackend(
  modelArg: string | undefined,
  runPreflight: boolean,
): Promise<{
  type: 'text'
  value: string
}> {
  if (runPreflight) {
    const preflight = await checkMicrophonePreflight()
    if (preflight) return preflight
  }
  const { isLocalSttModelId, LOCAL_STT_MODELS, formatMegabytes } = await import(
    '../../services/localStt/catalog.js'
  )
  const { currentLocalSttModel } = await import(
    '../../services/localSttStream.js'
  )
  const {
    checkLocalSttReadiness,
    describeInstallProgress,
    ensureLocalSttInstalled,
    getInstallProgress,
  } = await import('../../services/localStt/install.js')

  if (modelArg !== undefined && !isLocalSttModelId(modelArg)) {
    const options = Object.values(LOCAL_STT_MODELS)
      .map(
        model =>
          `  ${model.id} — ${model.label}, ${formatMegabytes(model.bytes)}, ${model.languages}`,
      )
      .join('\n')
    return {
      type: 'text' as const,
      value: `未知的本地模型 "${modelArg}"。可选：\n${options}`,
    }
  }

  const settingsPatch: {
    voiceEnabled: true
    voiceProvider: 'local'
    voiceLocalModel?: 'sense-voice' | 'paraformer-zh-small' | 'whisper-tiny'
  } = { voiceEnabled: true, voiceProvider: 'local' }
  if (modelArg !== undefined && isLocalSttModelId(modelArg)) {
    settingsPatch.voiceLocalModel = modelArg
  }
  const saved = updateSettingsForSource('userSettings', settingsPatch)
  if (saved.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_voice_toggled', { enabled: true })

  const model = currentLocalSttModel()
  const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
  const readiness = checkLocalSttReadiness(model)
  if (readiness.ready) {
    return {
      type: 'text' as const,
      value: `语音模式已启用（本地离线识别 · ${model.label}）。按住 ${key} 说话。`,
    }
  }

  const phase = getInstallProgress().phase
  if (phase === 'runtime' || phase === 'model' || phase === 'installing') {
    return {
      type: 'text' as const,
      value: `${describeInstallProgress()}\n下载完成后按住 ${key} 即可离线听写。`,
    }
  }
  // A platform with no prebuilt artifact fails here rather than starting a
  // download that cannot succeed; the reason names the platform.
  if (readiness.reason.includes('没有')) {
    return { type: 'text' as const, value: readiness.reason }
  }

  void ensureLocalSttInstalled(model).catch(() => {
    // Surfaced through describeInstallProgress on the next /voice local;
    // the installer already recorded the message.
  })
  return {
    type: 'text' as const,
    value:
      `语音模式已启用（本地离线识别 · ${model.label}，${model.languages}）。\n` +
      `正在后台下载识别引擎与模型（约 ${formatMegabytes(model.bytes)} 模型 + 约 20 MB 引擎），` +
      '仅此一次，之后完全离线、无需账号。\n' +
      `再次运行 /voice local 可查看进度；换模型用 /voice local <${Object.keys(LOCAL_STT_MODELS).join('|')}>。`,
  }
}

export const call: LocalCommandCall = async args => {
  // Check kill-switch before allowing voice mode
  if (!isVoiceAvailable()) {
    return {
      type: 'text' as const,
      value: 'Voice mode is not available.',
    }
  }

  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.voiceEnabled === true
  const argTokens = (args ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const providerArg = argTokens[0] ?? ''

  // `whisper` is accepted as a synonym for `local`: the backend runs
  // Whisper models among others, and it is the word users reach for.
  if (providerArg === 'local' || providerArg === 'whisper') {
    // Skip the microphone probe when voice is already on — it starts a
    // real recording, and `/voice local` doubles as the progress check.
    return handleLocalBackend(
      argTokens[1],
      !isCurrentlyEnabled || currentSettings.voiceProvider !== 'local',
    )
  }

  // Handle provider argument when already enabled — switch backend only
  if (isCurrentlyEnabled && providerArg === 'doubao') {
    const result = updateSettingsForSource('userSettings', {
      voiceProvider: 'doubao',
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
    return {
      type: 'text' as const,
      value: `Voice mode switched to Doubao ASR. Hold ${key} to record.`,
    }
  }

  // Handle provider argument when already enabled — switch to anthropic
  if (isCurrentlyEnabled && providerArg === 'anthropic') {
    const result = updateSettingsForSource('userSettings', {
      voiceProvider: 'anthropic',
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
    return {
      type: 'text' as const,
      value: `Voice mode switched to Anthropic STT. Hold ${key} to record.`,
    }
  }

  // Toggle OFF — no checks needed
  if (isCurrentlyEnabled) {
    const result = updateSettingsForSource('userSettings', {
      voiceEnabled: false,
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    logEvent('tengu_voice_toggled', { enabled: false })
    return {
      type: 'text' as const,
      value: 'Voice mode disabled.',
    }
  }

  // Toggle ON — determine provider from argument or default
  const provider = providerArg === 'doubao' ? 'doubao' : 'anthropic'

  // Run pre-flight checks
  const { isVoiceStreamAvailable } = await import(
    '../../services/voiceStreamSTT.js'
  )
  const { checkRecordingAvailability } = await import('../../services/voice.js')

  // Check recording availability (microphone access)
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? 'Voice mode is not available in this environment.',
    }
  }

  // Check for API key (only for Anthropic backend — Doubao uses its own credentials)
  if (provider !== 'doubao' && !isVoiceStreamAvailable()) {
    return {
      type: 'text' as const,
      value:
        'Voice mode requires a Claude.ai account. Please run /login to sign in.',
    }
  }

  // Check for recording tools
  const { checkVoiceDependencies, requestMicrophonePermission } = await import(
    '../../services/voice.js'
  )
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `\nInstall audio recording tools? Run: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording.'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  // Probe mic access so the OS permission dialog fires now rather than
  // on the user's first hold-to-talk activation.
  if (!(await requestMicrophonePermission())) {
    let guidance: string
    if (process.platform === 'win32') {
      guidance = 'Settings \u2192 Privacy \u2192 Microphone'
    } else if (process.platform === 'linux') {
      guidance = "your system's audio settings"
    } else {
      guidance = 'System Settings \u2192 Privacy & Security \u2192 Microphone'
    }
    return {
      type: 'text' as const,
      value: `Microphone access is denied. To enable it, go to ${guidance}, then run /voice again.`,
    }
  }

  // All checks passed — enable voice with provider
  const result = updateSettingsForSource('userSettings', {
    voiceEnabled: true,
    ...(provider === 'doubao' ? { voiceProvider: 'doubao' } : {}),
  })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_voice_toggled', { enabled: true })
  const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
  let langNote = ''
  const providerLabel = provider === 'doubao' ? 'Doubao ASR' : 'Anthropic'
  // Doubao backend handles all languages natively — skip language hints
  if (provider !== 'doubao') {
    const stt = normalizeLanguageForSTT(currentSettings.language)
    const cfg = getGlobalConfig()
    const langChanged = cfg.voiceLangHintLastLanguage !== stt.code
    const priorCount = langChanged ? 0 : (cfg.voiceLangHintShownCount ?? 0)
    const showHint = !stt.fellBackFrom && priorCount < LANG_HINT_MAX_SHOWS
    if (stt.fellBackFrom) {
      langNote = ` Note: "${stt.fellBackFrom}" is not a supported dictation language; using English. Change it via /config.`
    } else if (showHint) {
      langNote = ` Dictation language: ${stt.code} (/config to change).`
    }
    if (langChanged || showHint) {
      saveGlobalConfig(prev => ({
        ...prev,
        voiceLangHintShownCount: priorCount + (showHint ? 1 : 0),
        voiceLangHintLastLanguage: stt.code,
      }))
    }
  }
  return {
    type: 'text' as const,
    value: `Voice mode enabled (${providerLabel}). Hold ${key} to record.${langNote}`,
  }
}
