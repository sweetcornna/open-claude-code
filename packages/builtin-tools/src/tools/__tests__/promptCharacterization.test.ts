/**
 * Thin spawner for the prompt characterization snapshots.
 *
 * The real assertions live in `promptCharacterization.runner.ts`. They run in
 * their own `bun test` process for two reasons:
 *
 *   - the runner installs a process-global `mock.module('bun:bundle')` and
 *     monkey-patches the exported SandboxManager object, neither of which is
 *     safe to leak into the rest of the suite;
 *   - importing BashTool alone costs ~15s of module graph, so one subprocess
 *     amortises that across all 17 scenarios.
 *
 * The child runs with an isolated cwd and config dir so that a developer's
 * local `.claude/settings.json` (attribution, includeGitInstructions) cannot
 * change the snapshots.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const RUNNER = resolve(__dirname, 'promptCharacterization.runner.ts')

describe('tool prompt characterization', () => {
  test('renders every scenario byte-identically to the committed snapshots', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'occ-prompt-char-'))

    const proc = Bun.spawn(['bun', 'test', '--timeout', '60000', RUNNER], {
      cwd: isolated,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        // Auth must resolve without touching the keychain: isPDFSupported()
        // reaches getDefaultMainLoopModel() -> isMaxSubscriber() -> auth.
        ANTHROPIC_API_KEY: 'sk-ant-prompt-characterization',
        // No user-level settings, no user-level config.
        OCC_CONFIG_DIR: join(isolated, 'config'),
        CLAUDE_CONFIG_DIR: join(isolated, 'config'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `prompt characterization subprocess failed (exit ${code}).\n` +
          'A snapshot changed means a tool prompt changed — that busts the API\n' +
          'prompt cache for every session. Re-run with --update-snapshots only\n' +
          'if the wording change is intentional.\n\n' +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    expect(code).toBe(0)
  }, 300_000)
})
