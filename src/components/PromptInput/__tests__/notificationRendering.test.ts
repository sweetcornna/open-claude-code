import { describe, expect, test } from 'bun:test'
import type { Notification } from '../../../context/notifications.js'
import {
  shouldDisplayNotification,
  sortPinnedNotifications,
} from '../../../context/notifications.js'

function notification(
  key: string,
  priority: Notification['priority'],
): Notification {
  return { key, text: key, priority }
}

describe('PromptInput notification rendering', () => {
  test('sorts pinned notifications by priority without disturbing equal-priority insertion order', () => {
    const low = notification('low', 'low')
    const highFirst = notification('high-first', 'high')
    const immediate = notification('immediate', 'immediate')
    const highSecond = notification('high-second', 'high')

    const sorted = sortPinnedNotifications([
      low,
      highFirst,
      immediate,
      highSecond,
    ])

    expect(sorted.map(item => item.key)).toEqual([
      'immediate',
      'high-first',
      'high-second',
      'low',
    ])
  })

  test('hides ordinary current notifications during diff but keeps exempt errors visible', () => {
    expect(
      shouldDisplayNotification(notification('ordinary', 'medium'), true),
    ).toBe(false)
    expect(
      shouldDisplayNotification(
        {
          ...notification('error', 'immediate'),
          exemptFromDiffPanelHold: true,
        },
        true,
      ),
    ).toBe(true)
  })
})
