import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const RUNNER = resolve(__dirname, 'managedEndpointAuth.runner.ts')

/**
 * Runs in its own bun process, for the same reason as
 * utils/auth/__tests__/mirroredCredentialSinks.test.ts: the assertions are
 * about the real auth chain, and `mock.module` is process-global and
 * last-write-wins. Any other file in the src/services shard that stubs
 * src/utils/auth/auth.js would replace the thing under test with one whose
 * getAnthropicApiKeyWithSource() returns nothing — and then every "the
 * mirrored key did not travel" claim passes for the wrong reason.
 *
 * Covers both managed-fetch services (policy limits and remote managed
 * settings); they carry the same local api-key-first header builder.
 */
describe('managed-endpoint auth never carries a mirrored credential', () => {
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
        `managed-endpoint auth subprocess failed (exit ${code}).\n\n` +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    expect(code).toBe(0)
  }, 120_000)
})
