import { describe, expect, test } from 'bun:test'
import wellbeingCommand from '../index.js'
import { formatWellbeingStatus, parseWellbeingCommand } from '../wellbeing.js'

describe('/wellbeing command definition', () => {
  test('carries the upstream aliases', () => {
    expect(wellbeingCommand.name).toBe('wellbeing')
    expect(wellbeingCommand.aliases).toEqual([
      'breaks',
      'break-reminder',
      'downtime',
    ])
  })
})

describe('parseWellbeingCommand', () => {
  test('no arguments shows status', () => {
    expect(parseWellbeingCommand('')).toEqual({ kind: 'status' })
    expect(parseWellbeingCommand('   ')).toEqual({ kind: 'status' })
    expect(parseWellbeingCommand('status')).toEqual({ kind: 'status' })
  })

  test('toggles', () => {
    expect(parseWellbeingCommand('on')).toEqual({
      kind: 'toggle',
      enabled: true,
    })
    expect(parseWellbeingCommand('ENABLE')).toEqual({
      kind: 'toggle',
      enabled: true,
    })
    expect(parseWellbeingCommand('off')).toEqual({
      kind: 'toggle',
      enabled: false,
    })
  })

  test('interval accepts a verb or a bare number', () => {
    expect(parseWellbeingCommand('interval 45')).toEqual({
      kind: 'interval',
      minutes: 45,
    })
    expect(parseWellbeingCommand('45')).toEqual({
      kind: 'interval',
      minutes: 45,
    })
  })

  test('rejects nonsense minute values', () => {
    expect(parseWellbeingCommand('interval 0').kind).toBe('error')
    expect(parseWellbeingCommand('interval -5').kind).toBe('error')
    expect(parseWellbeingCommand('interval abc').kind).toBe('error')
    expect(parseWellbeingCommand('interval').kind).toBe('error')
    expect(parseWellbeingCommand('interval 2000').kind).toBe('error')
  })

  test('break threshold', () => {
    expect(parseWellbeingCommand('break 15')).toEqual({
      kind: 'break',
      minutes: 15,
    })
  })

  test('quiet hours ranges', () => {
    expect(parseWellbeingCommand('quiet 22:00-07:00')).toEqual({
      kind: 'quiet',
      start: '22:00',
      end: '07:00',
    })
    expect(parseWellbeingCommand('quiet 9:30 - 17:00')).toEqual({
      kind: 'quiet',
      start: '9:30',
      end: '17:00',
    })
    expect(parseWellbeingCommand('quiet off')).toEqual({ kind: 'quiet-off' })
    expect(parseWellbeingCommand('quiet 25:00-07:00').kind).toBe('error')
    expect(parseWellbeingCommand('quiet 22:00-22:00').kind).toBe('error')
  })

  test('custom message set and clear', () => {
    expect(parseWellbeingCommand('message go outside')).toEqual({
      kind: 'message',
      text: 'go outside',
    })
    expect(parseWellbeingCommand('message clear')).toEqual({
      kind: 'message',
      text: undefined,
    })
  })

  test('unknown option is an error, not a silent status', () => {
    expect(parseWellbeingCommand('sideways').kind).toBe('error')
  })
})

describe('formatWellbeingStatus', () => {
  test('reports defaults when nothing is configured', () => {
    const text = formatWellbeingStatus({}, {})
    expect(text).toContain('Break reminder: off')
    expect(text).toContain('30 min')
    expect(text).toContain('Quiet hours: off')
  })

  test('reports configured values', () => {
    const text = formatWellbeingStatus(
      { enabled: true, intervalMinutes: 45, breakThresholdMinutes: 15 },
      { enabled: true, start: '22:00', end: '07:00' },
    )
    expect(text).toContain('Break reminder: on')
    expect(text).toContain('45 min')
    expect(text).toContain('15 min idle')
    expect(text).toContain('22:00 to 07:00')
  })
})
