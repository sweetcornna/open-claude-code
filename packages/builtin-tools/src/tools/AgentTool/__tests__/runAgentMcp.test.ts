/**
 * runAgentMcp.test.ts
 *
 * 薄层子进程包装器：实际断言在 runAgentMcp.runner.ts 里。
 * runner 需要替换 src/services/mcp/{client,config}，进程全局的 mock.module
 * 会污染同分片的其他文件，所以单开一个进程跑。
 */
import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'runAgentMcp.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('runAgent MCP wiring', () => {
  test('runs all runAgent MCP tests in isolated subprocess', async () => {
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
        `runAgent MCP test subprocess failed (exit ${code}):\n${output}`,
      )
    }
    expect(code).toBe(0)
  }, 60_000)
})
