import { describe, expect, test } from 'bun:test'
import type { Notification } from '../../../context/notifications.js'
import {
  getNext,
  shouldDisplayNotification,
} from '../../../context/notifications.js'

const ordinary: Notification = {
  key: 'ordinary',
  text: 'ordinary',
  priority: 'high',
}

const error: Notification = {
  key: 'error',
  text: 'error',
  priority: 'immediate',
  exemptFromDiffPanelHold: true,
}

describe('diff notification integration', () => {
  test('diff eligibility selects exempt safety/error notifications and holds ordinary notifications', () => {
    const eligible = [ordinary, error].filter(
      notification => notification.exemptFromDiffPanelHold === true,
    )

    expect(getNext(eligible)?.key).toBe('error')
    expect(shouldDisplayNotification(ordinary, true)).toBe(false)
    expect(shouldDisplayNotification(error, true)).toBe(true)
  })
})
