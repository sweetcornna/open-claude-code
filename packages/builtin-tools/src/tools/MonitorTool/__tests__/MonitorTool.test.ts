/**
 * MonitorTool.test.ts
 *
 * 薄层子进程包装器，在独立的 bun:test 进程中运行实际测试
 * （见 MonitorTool.runner.ts 顶部关于 mock 隔离的说明）。
 */
import { describe, expect, test } from 'bun:test'
import { resolve, relative } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'MonitorTool.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('MonitorTool', () => {
  test('runs all MonitorTool tests in isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = (stderr + '\n' + stdout).slice(-3000)
      throw new Error(
        `MonitorTool test subprocess failed (exit ${code}):\n${output}`,
      )
    }
    expect(code).toBe(0)
  }, 60_000)
})
