import type { LocalCommandCall } from '../../types/command.js'
import {
  type BreakReminderSettings,
  DEFAULT_BREAK_THRESHOLD_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  getBreakReminderSettings,
  getQuietHoursSettings,
  parseClockMinutes,
  type QuietHoursSettings,
} from '../../services/wellbeing/reminder.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const USAGE = [
  'Usage:',
  '  /wellbeing                     show current settings',
  '  /wellbeing on | off            turn the break reminder on or off',
  '  /wellbeing interval <minutes>  minutes of continuous use before a nudge',
  '  /wellbeing break <minutes>     idle minutes that count as a break',
  '  /wellbeing quiet 22:00-07:00   set and enable quiet hours',
  '  /wellbeing quiet off           disable quiet hours',
  '  /wellbeing message <text>      custom nudge text ("message clear" to reset)',
].join('\n')

export type WellbeingAction =
  | { kind: 'status' }
  | { kind: 'toggle'; enabled: boolean }
  | { kind: 'interval'; minutes: number }
  | { kind: 'break'; minutes: number }
  | { kind: 'quiet'; start: string; end: string }
  | { kind: 'quiet-off' }
  | { kind: 'message'; text: string | undefined }
  | { kind: 'error'; reason: string }

const MAX_MINUTES = 24 * 60

function parseMinutes(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const minutes = Number(raw)
  if (minutes < 1 || minutes > MAX_MINUTES) return null
  return minutes
}

/**
 * Parse `/wellbeing` arguments. Pure — the command's I/O lives in `call`.
 */
export function parseWellbeingCommand(args: string): WellbeingAction {
  const trimmed = args.trim()
  if (!trimmed) return { kind: 'status' }

  const [rawVerb = '', ...rest] = trimmed.split(/\s+/)
  const verb = rawVerb.toLowerCase()

  switch (verb) {
    case 'on':
    case 'enable':
      return { kind: 'toggle', enabled: true }
    case 'off':
    case 'disable':
      return { kind: 'toggle', enabled: false }
    case 'status':
      return { kind: 'status' }
    case 'interval':
    case 'every': {
      const minutes = parseMinutes(rest[0])
      return minutes === null
        ? {
            kind: 'error',
            reason: `Expected a whole number of minutes (1-${MAX_MINUTES}), got "${rest[0] ?? ''}".`,
          }
        : { kind: 'interval', minutes }
    }
    case 'break':
    case 'threshold': {
      const minutes = parseMinutes(rest[0])
      return minutes === null
        ? {
            kind: 'error',
            reason: `Expected a whole number of minutes (1-${MAX_MINUTES}), got "${rest[0] ?? ''}".`,
          }
        : { kind: 'break', minutes }
    }
    case 'quiet':
    case 'quiet-hours': {
      const value = rest.join(' ').trim().toLowerCase()
      if (value === 'off' || value === 'disable') return { kind: 'quiet-off' }
      const match = /^(\d{1,2}:\d{2})\s*(?:-|to|–)\s*(\d{1,2}:\d{2})$/.exec(
        value,
      )
      const start = match?.[1]
      const end = match?.[2]
      if (
        start === undefined ||
        end === undefined ||
        parseClockMinutes(start) === null ||
        parseClockMinutes(end) === null
      ) {
        return {
          kind: 'error',
          reason: 'Expected a 24-hour range like "22:00-07:00", or "off".',
        }
      }
      if (start === end) {
        return {
          kind: 'error',
          reason: 'Quiet hours cannot start and end at the same time.',
        }
      }
      return { kind: 'quiet', start, end }
    }
    case 'message': {
      const text = trimmed.slice(rawVerb.length).trim()
      if (
        !text ||
        text.toLowerCase() === 'clear' ||
        text.toLowerCase() === 'reset'
      ) {
        return { kind: 'message', text: undefined }
      }
      return { kind: 'message', text }
    }
    default: {
      // Bare number is shorthand for the interval, matching how people say it.
      const minutes = parseMinutes(verb)
      if (minutes !== null && rest.length === 0) {
        return { kind: 'interval', minutes }
      }
      return { kind: 'error', reason: `Unknown option "${rawVerb}".` }
    }
  }
}

/** Human-readable summary of both opt-in features. Pure. */
export function formatWellbeingStatus(
  breakReminder: BreakReminderSettings,
  quietHours: QuietHoursSettings,
): string {
  const interval = breakReminder.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
  const threshold =
    breakReminder.breakThresholdMinutes ?? DEFAULT_BREAK_THRESHOLD_MINUTES
  const lines = [
    breakReminder.enabled
      ? `Break reminder: on — after ${interval} min of continuous use, reset by ${threshold} min idle`
      : `Break reminder: off (would nudge every ${interval} min of continuous use)`,
  ]
  if (breakReminder.message) {
    lines.push(`Custom message: ${breakReminder.message}`)
  }
  lines.push(
    quietHours.enabled && quietHours.start && quietHours.end
      ? `Quiet hours: on — ${quietHours.start} to ${quietHours.end} (one nudge per session)`
      : 'Quiet hours: off',
  )
  lines.push('', USAGE)
  return lines.join('\n')
}

const call: LocalCommandCall = async args => {
  const action = parseWellbeingCommand(args)

  switch (action.kind) {
    case 'status':
      return {
        type: 'text',
        value: formatWellbeingStatus(
          getBreakReminderSettings(),
          getQuietHoursSettings(),
        ),
      }

    case 'error':
      return { type: 'text', value: `${action.reason}\n\n${USAGE}` }

    case 'toggle': {
      const error = save({ breakReminder: { enabled: action.enabled } })
      if (error) return error
      return {
        type: 'text',
        value: action.enabled
          ? `Break reminder on — a nudge after ${
              getBreakReminderSettings().intervalMinutes ??
              DEFAULT_INTERVAL_MINUTES
            } min of continuous use.`
          : 'Break reminder off.',
      }
    }

    case 'interval': {
      // Setting an interval implies you want the reminder; turning it off is
      // an explicit "/wellbeing off".
      const error = save({
        breakReminder: { enabled: true, intervalMinutes: action.minutes },
      })
      if (error) return error
      return {
        type: 'text',
        value: `Break reminder on — every ${action.minutes} min of continuous use.`,
      }
    }

    case 'break': {
      const error = save({
        breakReminder: { breakThresholdMinutes: action.minutes },
      })
      if (error) return error
      return {
        type: 'text',
        value: `Break threshold set to ${action.minutes} min idle.`,
      }
    }

    case 'quiet': {
      const error = save({
        quietHours: { enabled: true, start: action.start, end: action.end },
      })
      if (error) return error
      return {
        type: 'text',
        value: `Quiet hours on — ${action.start} to ${action.end}.`,
      }
    }

    case 'quiet-off': {
      const error = save({ quietHours: { enabled: false } })
      if (error) return error
      return { type: 'text', value: 'Quiet hours off.' }
    }

    case 'message': {
      const error = save({ breakReminder: { message: action.text } })
      if (error) return error
      return {
        type: 'text',
        value: action.text
          ? `Custom nudge set: ${action.text}`
          : 'Custom nudge cleared — back to the rotating set.',
      }
    }
  }
}

function save(update: {
  breakReminder?: BreakReminderSettings
  quietHours?: QuietHoursSettings
}): { type: 'text'; value: string } | null {
  const { error } = updateSettingsForSource('userSettings', update)
  if (error) {
    return { type: 'text', value: `Could not save settings: ${error.message}` }
  }
  return null
}

export { call }
