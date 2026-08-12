import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import {
  getContinuousUseMs,
  noteUserActivity,
  resetActivityTracker,
} from '../activityTracker.js'
import {
  collectWellbeingNudges,
  isWithinQuietHours,
  parseClockMinutes,
  resetWellbeingSessionState,
} from '../reminder.js'

const settingsMock = setupSettingsMock()

let settings: SettingsJson = {}

beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => settings })
})

afterAll(() => {
  settingsMock.reset()
})

beforeEach(() => {
  settings = {}
  resetActivityTracker()
  resetWellbeingSessionState()
})

const MIN = 60_000

describe('activity tracker', () => {
  test('accumulates continuous use across close activity', () => {
    noteUserActivity(0)
    noteUserActivity(5 * MIN)
    expect(getContinuousUseMs(5 * MIN)).toBe(5 * MIN)
  })

  test('a gap longer than the break threshold starts a new stretch', () => {
    noteUserActivity(0)
    // 10 min default threshold — this gap counts as a break.
    noteUserActivity(20 * MIN)
    expect(getContinuousUseMs(20 * MIN)).toBe(0)
  })

  test('reports no continuous use while the user is away', () => {
    noteUserActivity(0)
    expect(getContinuousUseMs(30 * MIN)).toBeNull()
  })
})

describe('collectWellbeingNudges — break reminder', () => {
  test('stays silent when not enabled', () => {
    settings = { breakReminder: { intervalMinutes: 1 } }
    noteUserActivity(Date.now())
    expect(collectWellbeingNudges()).toEqual([])
  })

  test('fires once the interval of continuous use is reached', () => {
    settings = { breakReminder: { enabled: true, intervalMinutes: 30 } }
    const start = Date.now()
    // Keep the stretch alive with activity inside the break threshold.
    for (let t = 0; t <= 30 * MIN; t += 5 * MIN) noteUserActivity(start + t)

    const nudges = collectWellbeingNudges(new Date(start + 30 * MIN))
    expect(nudges).toHaveLength(1)
    expect(nudges[0]).toContain('break')
  })

  test('does not fire before the interval', () => {
    settings = { breakReminder: { enabled: true, intervalMinutes: 30 } }
    const start = Date.now()
    noteUserActivity(start)
    noteUserActivity(start + 5 * MIN)
    expect(collectWellbeingNudges(new Date(start + 5 * MIN))).toEqual([])
  })

  test('re-fires every interval and rotates the wording', () => {
    settings = { breakReminder: { enabled: true, intervalMinutes: 30 } }
    const start = Date.now()
    for (let t = 0; t <= 60 * MIN; t += 5 * MIN) noteUserActivity(start + t)

    const first = collectWellbeingNudges(new Date(start + 30 * MIN))
    const between = collectWellbeingNudges(new Date(start + 45 * MIN))
    const second = collectWellbeingNudges(new Date(start + 60 * MIN))

    expect(first).toHaveLength(1)
    expect(between).toEqual([])
    expect(second).toHaveLength(1)
    expect(second[0]).not.toBe(first[0])
  })

  test('a real break resets the counter', () => {
    settings = { breakReminder: { enabled: true, intervalMinutes: 30 } }
    const start = Date.now()
    for (let t = 0; t <= 30 * MIN; t += 5 * MIN) noteUserActivity(start + t)
    expect(collectWellbeingNudges(new Date(start + 30 * MIN))).toHaveLength(1)

    // Away for an hour, then back: the next 30 minutes must elapse again.
    noteUserActivity(start + 90 * MIN)
    expect(collectWellbeingNudges(new Date(start + 90 * MIN))).toEqual([])
  })

  test('honors a custom message', () => {
    settings = {
      breakReminder: { enabled: true, intervalMinutes: 1, message: 'go walk' },
    }
    const start = Date.now()
    noteUserActivity(start)
    noteUserActivity(start + MIN)
    expect(collectWellbeingNudges(new Date(start + MIN))).toEqual(['go walk'])
  })

  test('breakThresholdMinutes widens what counts as continuous', () => {
    settings = {
      breakReminder: {
        enabled: true,
        intervalMinutes: 30,
        breakThresholdMinutes: 60,
      },
    }
    const start = Date.now()
    noteUserActivity(start)
    // Pull the configured threshold into the tracker.
    collectWellbeingNudges(new Date(start))
    // A 20 min gap would be a break at the default threshold, not at 60.
    noteUserActivity(start + 20 * MIN)
    noteUserActivity(start + 40 * MIN)
    expect(collectWellbeingNudges(new Date(start + 40 * MIN))).toHaveLength(1)
  })
})

describe('quiet hours', () => {
  test('parseClockMinutes', () => {
    expect(parseClockMinutes('22:00')).toBe(22 * 60)
    expect(parseClockMinutes('7:05')).toBe(7 * 60 + 5)
    expect(parseClockMinutes('24:00')).toBeNull()
    expect(parseClockMinutes('nope')).toBeNull()
    expect(parseClockMinutes(undefined)).toBeNull()
  })

  test('overnight windows wrap midnight', () => {
    const window = { enabled: true, start: '22:00', end: '07:00' }
    expect(isWithinQuietHours(window, at(23, 30))).toBe(true)
    expect(isWithinQuietHours(window, at(2, 0))).toBe(true)
    expect(isWithinQuietHours(window, at(7, 0))).toBe(false)
    expect(isWithinQuietHours(window, at(12, 0))).toBe(false)
  })

  test('same-day windows do not wrap', () => {
    const window = { enabled: true, start: '09:00', end: '17:00' }
    expect(isWithinQuietHours(window, at(12, 0))).toBe(true)
    expect(isWithinQuietHours(window, at(8, 59))).toBe(false)
    expect(isWithinQuietHours(window, at(17, 0))).toBe(false)
  })

  test('disabled or incomplete windows never match', () => {
    expect(
      isWithinQuietHours({ start: '22:00', end: '07:00' }, at(23, 0)),
    ).toBe(false)
    expect(
      isWithinQuietHours({ enabled: true, start: '22:00' }, at(23, 0)),
    ).toBe(false)
  })

  test('nudges at most once per session', () => {
    settings = { quietHours: { enabled: true, start: '22:00', end: '07:00' } }
    expect(collectWellbeingNudges(at(23, 0))).toHaveLength(1)
    expect(collectWellbeingNudges(at(23, 30))).toEqual([])
  })

  test('stays silent outside the window', () => {
    settings = { quietHours: { enabled: true, start: '22:00', end: '07:00' } }
    expect(collectWellbeingNudges(at(12, 0))).toEqual([])
  })
})

function at(hours: number, minutes: number): Date {
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  return date
}
