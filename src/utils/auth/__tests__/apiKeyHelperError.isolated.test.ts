import { expect, test } from 'bun:test'
import { resolve } from 'path'

const RUNNER = resolve(__dirname, 'apiKeyHelperError.runner.ts')

test('apiKeyHelper error lifecycle uses the real auth module', async () => {
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
      `apiKeyHelper lifecycle subprocess failed (exit ${code}).\n\n` +
        `${stderr}\n${stdout}`.slice(-6000),
    )
  }
  expect(code).toBe(0)
}, 120_000)
