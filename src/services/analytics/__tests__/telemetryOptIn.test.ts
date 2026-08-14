import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const RUNNER = resolve(__dirname, 'telemetryOptIn.runner.ts')

/**
 * The opt-in assertions run in their own bun process, for two reasons that
 * both make them meaningless in-process:
 *
 * 1. They need NODE_ENV unset. isAnalyticsDisabled() short-circuits on
 *    NODE_ENV === 'test', so in the shared process every "no traffic" claim
 *    would pass regardless of the production defaults.
 * 2. They assert on the real auth chain — that getAuthHeaders() still hands a
 *    mirrored DeepSeek key to inference while the first-party path refuses it.
 *    `mock.module` is process-global and last-write-wins, so any other file in
 *    the run that mocks src/utils/auth/auth.js replaces the thing under test
 *    with `getAnthropicApiKey: () => null` and every assertion turns green for
 *    the wrong reason. Same reasoning as logoutFailure.test.ts.
 */
describe('first-party telemetry opt-in', () => {
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
        `telemetry opt-in subprocess failed (exit ${code}).\n\n` +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    expect(code).toBe(0)
  }, 120_000)
})
