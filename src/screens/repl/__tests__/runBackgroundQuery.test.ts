import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'runBackgroundQuery.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('runBackgroundQuery', () => {
  test('preserves foreground state when preparation fails', async () => {
    // messageQueueManager mock.module registrations are process-global, so the
    // behavior check must load its real queue in a fresh module registry.
    const proc = Bun.spawn([process.execPath, 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = `${stderr}\n${stdout}`.slice(-3000)
      throw new Error(
        `runBackgroundQuery subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
