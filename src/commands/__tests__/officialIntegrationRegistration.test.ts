import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const sourceRoot = resolve(import.meta.dir, '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
}

function sourceExists(relativePath: string): boolean {
  return existsSync(resolve(sourceRoot, relativePath))
}

// REPL.tsx was split into screens/repl/ (S7-4d). A negative assertion that
// reads only REPL.tsx would still pass if the symbol reappeared in one of the
// extracted modules, so scan the whole screen.
function readReplSources(): string {
  const replDir = resolve(sourceRoot, 'screens', 'repl')
  const files = readdirSync(replDir, { recursive: true })
    .map(String)
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .sort()
  return [
    readSource('screens/REPL.tsx'),
    ...files.map(name => readFileSync(resolve(replDir, name), 'utf8')),
  ].join('\n')
}

describe('official integration registration', () => {
  test('does not register the official GitHub App installer command or tip', () => {
    const commandsSource = readSource('commands.ts')
    const tipsSource = readSource('services/tips/tipRegistry.ts')

    expect(commandsSource).not.toContain(
      './commands/install-github-app/index.js',
    )
    expect(commandsSource).not.toMatch(/\binstallGitHubApp\b/)
    expect(tipsSource).not.toContain("id: 'install-github-app'")
    expect(tipsSource).not.toContain('/install-github-app')
  })

  test('does not run official marketplace installation during REPL startup', () => {
    const replSource = readReplSources()

    expect(replSource).not.toContain('useOfficialMarketplaceNotification')
    // The hook and its startup check are gone entirely, which is a stronger
    // guarantee than asserting their contents. Pin the absence so a
    // reintroduction has to be deliberate.
    expect(sourceExists('hooks/useOfficialMarketplaceNotification.tsx')).toBe(
      false,
    )
    expect(
      sourceExists('utils/plugins/officialMarketplaceStartupCheck.ts'),
    ).toBe(false)
  })

  test('does not register the Anthropic Slack diagnostic skill', () => {
    const registrySource = readSource('skills/bundled/index.ts')

    expect(registrySource).not.toContain("from './stuck.js'")
    expect(registrySource).not.toContain('registerStuckSkill')
  })
})
