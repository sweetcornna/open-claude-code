import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const RUNNER = resolve(__dirname, 'mirroredCredentialSinks.runner.ts')

/**
 * Runs in its own bun process, for the same two reasons as
 * telemetryOptIn.test.ts:
 *
 * 1. The assertions are about the real auth chain — that a mirrored DeepSeek
 *    key still reaches inference while every request occ addresses to
 *    api.anthropic.com refuses it. `mock.module` is process-global and
 *    last-write-wins, so any other file in the run that mocks
 *    src/utils/auth/auth.js replaces the thing under test with a stub whose
 *    getAnthropicApiKey() returns null — and then every "the key did not
 *    travel" claim passes for the wrong reason.
 * 2. Several of these sinks reach for config, settings and the keychain
 *    through modules other files in the shard also mock. Isolating the process
 *    is what makes "no request was made" mean the production code decided that,
 *    rather than a leftover stub.
 */
describe('mirrored third-party credentials never reach api.anthropic.com', () => {
  test('runs without process-global auth mocks', async () => {
    const proc = Bun.spawn(['bun', 'test', '--timeout', '60000', RUNNER], {
      cwd: resolve(__dirname, '..', '..', '..', '..'),
      env: { ...process.env, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `mirrored credential subprocess failed (exit ${code}).\n\n` +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    expect(code).toBe(0)
  }, 120_000)
})
