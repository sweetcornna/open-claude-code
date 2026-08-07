import { describe, expect, test } from 'bun:test'

import { isChannelAllowlisted } from '../channelAllowlist.js'

describe('isChannelAllowlisted', () => {
  test('rejects undefined plugin source', () => {
    expect(isChannelAllowlisted(undefined)).toBe(false)
  })
})
