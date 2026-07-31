import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const sourceRoot = resolve(import.meta.dir, '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
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
    const replSource = readSource('screens/REPL.tsx')
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
