import { describe, expect, mock, test } from 'bun:test'

mock.module('../../analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => [],
}))

import { isChannelAllowlisted } from '../channelAllowlist.js'

describe('isChannelAllowlisted', () => {
  test('rejects undefined plugin source', () => {
    expect(isChannelAllowlisted(undefined)).toBe(false)
  })
})
