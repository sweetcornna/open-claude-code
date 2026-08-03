import { afterAll, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realConfig from 'src/utils/config/config.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const configMock = makeSharedModuleMock(
  'src/utils/config/config.js',
  realConfig,
).setup({
  saveGlobalConfig: () => {},
})

afterAll(() => {
  configMock.reset()
})

describe('GitHub Actions secret setup', () => {
  test('passes the token through stdin instead of child-process argv', async () => {
    const { setGitHubSecret } = await import('../setupGitHubActions.js')
    const calls: Array<{
      file: string
      args: string[]
      options: Parameters<NonNullable<Parameters<typeof setGitHubSecret>[3]>>[2]
    }> = []
    const execute: NonNullable<Parameters<typeof setGitHubSecret>[3]> = async (
      file,
      args,
      options,
    ) => {
      calls.push({ file, args, options })
      return { stdout: '', stderr: '', code: 0 }
    }

    await setGitHubSecret(
      'owner/repo',
      'ANTHROPIC_API_KEY',
      'token-visible-only-on-stdin',
      execute,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.file).toBe('gh')
    expect(calls[0]?.args).toEqual([
      'secret',
      'set',
      'ANTHROPIC_API_KEY',
      '--repo',
      'owner/repo',
    ])
    expect(calls[0]?.args.join(' ')).not.toContain(
      'token-visible-only-on-stdin',
    )
    expect(calls[0]?.options).toMatchObject({
      stdin: 'pipe',
      input: 'token-visible-only-on-stdin',
    })
  })
})
