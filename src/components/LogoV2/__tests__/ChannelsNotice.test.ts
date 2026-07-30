import { describe, expect, test } from 'bun:test'

import { findUnmatched } from '../ChannelsNotice.js'

describe('findUnmatched', () => {
  test('does not flag an installed builtin plugin as not installed', () => {
    expect(
      findUnmatched(
        [{ kind: 'plugin', name: 'demo', marketplace: 'builtin' }],
        {
          configuredServerNames: new Set(),
          installedPluginIds: new Set(['demo@builtin']),
        },
      ),
    ).toEqual([])
  })
})
