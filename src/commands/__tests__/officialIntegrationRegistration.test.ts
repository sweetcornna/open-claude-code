import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const sourceRoot = resolve(import.meta.dir, '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
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
    const hookSource = readSource(
      'hooks/useOfficialMarketplaceNotification.tsx',
    )

    expect(replSource).not.toContain('useOfficialMarketplaceNotification')
    expect(hookSource).not.toContain('checkAndInstallOfficialMarketplace')
    expect(hookSource).not.toContain('officialMarketplaceStartupCheck')
  })

  test('does not register the Anthropic Slack diagnostic skill', () => {
    const registrySource = readSource('skills/bundled/index.ts')

    expect(registrySource).not.toContain("from './stuck.js'")
    expect(registrySource).not.toContain('registerStuckSkill')
  })
})
