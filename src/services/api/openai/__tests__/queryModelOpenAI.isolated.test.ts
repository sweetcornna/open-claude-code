/**
 * Thin spawner for the queryModelOpenAI assertions.
 *
 * The real tests live in `queryModelOpenAI.runner.ts`. They install
 * process-global `mock.module` replacements for `@ant/model-provider`, the
 * OpenAI client, the stream adapter and the message/tool converters — Bun's
 * module mocks are process-wide and last-write-wins, so running them in the
 * shared process makes every sibling OpenAI suite (streamAdapter, wireProtocol,
 * client cache) fail against the stubs.
 *
 * That is why the file was originally named `.isolated.ts`: a name `bun test`
 * does not match. Nothing ever spawned it, so its assertions had not run since
 * they were written, and they had rotted — a missing mock export broke the
 * whole module graph, and one expectation still encoded pre-change behaviour.
 * A subprocess gives the isolation the name only claimed.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const RUNNER = resolve(__dirname, 'queryModelOpenAI.runner.ts')

describe('queryModelOpenAI (isolated)', () => {
  test('runs in its own process so its module mocks stay contained', async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: 'test',
    }
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('OPENAI_') ||
        key.startsWith('ANTHROPIC_') ||
        key === 'CLAUDE_CODE_USE_OPENAI' ||
        key === 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS' ||
        key === 'ENABLE_SEARCH_EXTRA_TOOLS'
      ) {
        delete env[key]
      }
    }

    const proc = Bun.spawn(['bun', 'test', '--timeout', '60000', RUNNER], {
      cwd: resolve(__dirname, '..', '..', '..', '..', '..'),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `queryModelOpenAI subprocess failed (exit ${code}).\n\n` +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    expect(code).toBe(0)
  }, 120_000)
})
