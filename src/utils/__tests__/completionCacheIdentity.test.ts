import { describe, expect, test } from 'bun:test'
import { hasOccCompletion } from '../completionCache.js'

const completionLine =
  '[[ -f "/home/test/.occ/completion.zsh" ]] && source "/home/test/.occ/completion.zsh"'

describe('hasOccCompletion', () => {
  test('recognizes the occ command and exact occ marker', () => {
    expect(
      hasOccCompletion('eval "$(occ completion zsh)"', completionLine),
    ).toBe(true)
    expect(
      hasOccCompletion(
        `# occ shell completions\n${completionLine}`,
        completionLine,
      ),
    ).toBe(true)
  })

  test('does not treat official Claude completion setup as occ setup', () => {
    expect(
      hasOccCompletion('eval "$(claude completion zsh)"', completionLine),
    ).toBe(false)
    expect(
      hasOccCompletion(
        `# Claude Code shell completions\n${completionLine}`,
        completionLine,
      ),
    ).toBe(false)
  })
})
