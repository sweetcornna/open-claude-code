/**
 * The Edit prompt is a pure leaf, so it can be exercised directly — no mocks,
 * no module graph. This covers the `compactLinePrefix` branch, which the
 * characterization snapshots cannot reach: it comes from a GrowthBook flag
 * that is fixed for the lifetime of a process.
 */
import { describe, expect, test } from 'bun:test'
import { renderEditToolDescription } from '../prompt.js'

describe('renderEditToolDescription', () => {
  test('describes the compact line-number prefix by default', () => {
    const prompt = renderEditToolDescription({
      compactLinePrefix: true,
      includeMinimalUniquenessHint: false,
    })
    expect(prompt).toContain(
      'The line number prefix format is: line number + tab.',
    )
    expect(prompt).not.toContain('spaces + line number + arrow')
  })

  test('describes the legacy arrow prefix when the killswitch is on', () => {
    const prompt = renderEditToolDescription({
      compactLinePrefix: false,
      includeMinimalUniquenessHint: false,
    })
    expect(prompt).toContain(
      'The line number prefix format is: spaces + line number + arrow.',
    )
  })

  test('adds the minimal-uniqueness hint only when asked', () => {
    const withHint = renderEditToolDescription({
      compactLinePrefix: true,
      includeMinimalUniquenessHint: true,
    })
    const withoutHint = renderEditToolDescription({
      compactLinePrefix: true,
      includeMinimalUniquenessHint: false,
    })
    expect(withHint).toContain('Use the smallest old_string')
    expect(withoutHint).not.toContain('Use the smallest old_string')
  })

  test('always names the Read tool as the pre-read requirement', () => {
    expect(
      renderEditToolDescription({
        compactLinePrefix: true,
        includeMinimalUniquenessHint: false,
      }),
    ).toContain('You must use your `Read` tool at least once')
  })
})
