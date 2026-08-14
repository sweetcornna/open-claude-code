/**
 * The Bash prompt is a pure leaf, so it can be exercised directly — no mocks,
 * no module graph. This covers the Windows/Git Bash branch, which the
 * characterization snapshots cannot reach: they run on the host platform, and
 * CI is not Windows.
 */
import { describe, expect, test } from 'bun:test'
import { renderBashPrompt, type BashPromptParams } from '../prompt.js'

const BASE: BashPromptParams = {
  embeddedSearchTools: false,
  maxTimeoutMs: 600_000,
  defaultTimeoutMs: 120_000,
  backgroundTasksEnabled: true,
  monitorTool: false,
  windowsGitBash: false,
  powershellToolAvailable: false,
  sandbox: null,
  git: {
    undercoverSection: '',
    includeGitInstructions: false,
    antUser: false,
    includeSkillsSection: false,
    commitAttribution: '',
    prAttribution: '',
  },
}

describe('renderBashPrompt — Windows shell note', () => {
  test('omits the Git Bash note off Windows', () => {
    const prompt = renderBashPrompt(BASE)
    expect(prompt).not.toContain('Git Bash')
    expect(prompt).not.toContain('cmd.exe')
  })

  test('warns that this is Git Bash, not cmd.exe or PowerShell', () => {
    const prompt = renderBashPrompt({ ...BASE, windowsGitBash: true })
    expect(prompt).toContain(
      'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell.',
    )
    // The concrete substitutions matter more than the framing: Git Bash
    // accepts `NUL` and `%VAR%` as literals rather than erroring.
    expect(prompt).toContain('`/dev/null` not `NUL`')
    expect(prompt).toContain('`$VAR` not `%VAR%` or `$env:VAR`')
    // Only added when a sibling PowerShell tool exists to confuse it with.
    expect(prompt).not.toContain('here-strings')
  })

  test('adds the PowerShell-syntax carve-out when that tool is also offered', () => {
    const prompt = renderBashPrompt({
      ...BASE,
      windowsGitBash: true,
      powershellToolAvailable: true,
    })
    expect(prompt).toContain('This tool runs Git Bash (POSIX sh)')
    expect(prompt).toContain("Do not use PowerShell here-strings (`@'…'@`)")
    expect(prompt).toContain('for multi-line strings use a heredoc')
  })

  test('powershellToolAvailable alone is inert — the note is Windows-gated', () => {
    const prompt = renderBashPrompt({ ...BASE, powershellToolAvailable: true })
    expect(prompt).not.toContain('here-strings')
    expect(prompt).not.toContain('Git Bash')
  })
})

describe('renderBashPrompt — sleep guidance', () => {
  test('offers the Monitor until-loop escape hatch when Monitor exists', () => {
    const prompt = renderBashPrompt({ ...BASE, monitorTool: true })
    expect(prompt).toContain('until <check>; do sleep 2; done')
    expect(prompt).toContain(
      'Do not chain shorter sleeps to work around the block.',
    )
  })

  test('says nothing about Monitor when the tool is not compiled in', () => {
    const prompt = renderBashPrompt(BASE)
    expect(prompt).not.toContain('until <check>')
    expect(prompt).toContain('If you must sleep, keep the duration short')
  })
})

describe('renderBashPrompt — cwd and git', () => {
  test('names the `cd <cwd> && git` compound explicitly', () => {
    // The generic "avoid cd" advice was not enough: prepending the cwd is the
    // one form models reach for, and it costs a permission prompt every time.
    const prompt = renderBashPrompt(BASE)
    expect(prompt).toContain(
      'never prepend `cd <current-directory>` to a `git` command',
    )
  })
})
