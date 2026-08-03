import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { TmuxEngine } from '../engines/tmux.js'

let tempDir: string | undefined
const originalPath = process.env.PATH
const originalRecordPath = process.env.OCC_TMUX_TEST_RECORD

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalRecordPath === undefined) delete process.env.OCC_TMUX_TEST_RECORD
  else process.env.OCC_TMUX_TEST_RECORD = originalRecordPath
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('TmuxEngine', () => {
  test('records engine metadata and pipes pane output to the advertised log', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'occ-tmux-'))
    const binDir = join(tempDir, 'bin')
    const recordPath = join(tempDir, 'tmux-calls.txt')
    const tmuxPath = join(binDir, 'tmux')
    const logPath = join(tempDir, 'logs with spaces', 'session.log')
    await mkdir(binDir, { recursive: true })
    await Bun.write(
      tmuxPath,
      `#!/bin/sh
printf 'args:' >> "$OCC_TMUX_TEST_RECORD"
printf ' <%s>' "$@" >> "$OCC_TMUX_TEST_RECORD"
printf '\nenv:%s|%s|%s\n' "$CLAUDE_CODE_SESSION_ENGINE" "$CLAUDE_CODE_TMUX_SESSION" "$CLAUDE_CODE_SESSION_LOG" >> "$OCC_TMUX_TEST_RECORD"
exit 0
`,
    )
    await chmod(tmuxPath, 0o755)
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    process.env.OCC_TMUX_TEST_RECORD = recordPath

    const engine = new TmuxEngine()
    const result = await engine.start({
      sessionName: 'occ-bg-test',
      args: ['-p', 'hello'],
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OCC_TMUX_TEST_RECORD: recordPath,
      },
      logPath,
      cwd: tempDir,
    })

    const calls = await readFile(recordPath, 'utf8')
    expect(calls).toContain('args: <new-session> <-d> <-s> <occ-bg-test>')
    expect(calls).toContain(`env:tmux|occ-bg-test|${logPath}`)
    expect(calls).toContain('args: <pipe-pane> <-o> <-t> <occ-bg-test>')
    expect(calls).toContain('cat >>')
    expect(await Bun.file(logPath).exists()).toBe(true)
    expect(result).toEqual({
      pid: 0,
      sessionName: 'occ-bg-test',
      logPath,
      engineUsed: 'tmux',
    })

    await engine.attach({
      pid: 123,
      sessionId: 'session-id',
      cwd: tempDir,
      startedAt: Date.now(),
      kind: 'bg',
      engine: 'tmux',
      tmuxSessionName: 'occ-bg-test',
    })
    expect(await readFile(recordPath, 'utf8')).toContain(
      'args: <attach-session> <-t> <occ-bg-test>',
    )
  })
})
