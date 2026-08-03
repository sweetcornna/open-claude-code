import { spawnSync } from 'child_process'
import { closeSync, mkdirSync, openSync } from 'fs'
import { dirname } from 'path'
import { quote } from '../../../utils/bash/shellQuote.js'
import { execFileNoThrow } from '../../../utils/process/execFileNoThrow.js'
import {
  buildCliLaunch,
  quoteCliLaunch,
} from '../../../utils/process/cliLaunch.js'
import type {
  BgEngine,
  BgStartOptions,
  BgStartResult,
  SessionEntry,
} from '../engine.js'

export class TmuxEngine implements BgEngine {
  readonly name = 'tmux' as const
  readonly supportsInteractiveInput = true

  async available(): Promise<boolean> {
    const { code } = await execFileNoThrow('tmux', ['-V'], { useCwd: false })
    return code === 0
  }

  async start(opts: BgStartOptions): Promise<BgStartResult> {
    const launch = buildCliLaunch(opts.args, {
      env: {
        ...opts.env,
        CLAUDE_CODE_SESSION_KIND: 'bg',
        CLAUDE_CODE_SESSION_NAME: opts.sessionName,
        CLAUDE_CODE_SESSION_LOG: opts.logPath,
        CLAUDE_CODE_SESSION_ENGINE: 'tmux',
        CLAUDE_CODE_TMUX_SESSION: opts.sessionName,
      } as NodeJS.ProcessEnv,
    })

    const cmd = quoteCliLaunch(launch)

    mkdirSync(dirname(opts.logPath), { recursive: true })
    closeSync(openSync(opts.logPath, 'a'))

    const result = spawnSync(
      'tmux',
      ['new-session', '-d', '-s', opts.sessionName, cmd],
      { stdio: 'inherit', env: launch.env },
    )

    if (result.status !== 0) {
      throw new Error('Failed to create tmux session.')
    }

    // tmux panes do not write to the child's stdout file descriptors, so the
    // advertised log path is only real when the pane output is piped explicitly.
    const pipeResult = spawnSync(
      'tmux',
      [
        'pipe-pane',
        '-o',
        '-t',
        opts.sessionName,
        `cat >> ${quote([opts.logPath])}`,
      ],
      { stdio: 'inherit', env: launch.env },
    )

    if (pipeResult.status !== 0) {
      spawnSync('tmux', ['kill-session', '-t', opts.sessionName], {
        stdio: 'ignore',
        env: launch.env,
      })
      throw new Error('Failed to capture tmux session output.')
    }

    // tmux doesn't directly report the child PID; we return 0.
    // The actual session process writes its own PID file.
    return {
      pid: 0,
      sessionName: opts.sessionName,
      logPath: opts.logPath,
      engineUsed: 'tmux',
    }
  }

  async attach(session: SessionEntry): Promise<void> {
    if (!session.tmuxSessionName) {
      throw new Error(`Session ${session.sessionId} has no tmux session name.`)
    }

    const result = spawnSync(
      'tmux',
      ['attach-session', '-t', session.tmuxSessionName],
      { stdio: 'inherit', env: process.env },
    )

    if (result.status !== 0) {
      throw new Error(
        `Failed to attach to tmux session '${session.tmuxSessionName}'.`,
      )
    }
  }
}
