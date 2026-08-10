import { readdir, readFile, unlink } from 'fs/promises'
import treeKill from 'tree-kill'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { BIN_NAME } from '../constants/brand.js'
import { occConfigPath } from '../config/paths.js'
import { getClaudeConfigHomeDir } from '../utils/config/envUtils.js'
import { isProcessRunning } from '../utils/process/genericProcessUtils.js'
import { getPlatform } from '../utils/process/platform.js'
import {
  getProcessStartMarker,
  removeManagedSessionLog,
} from '../utils/session/concurrentSessions.js'
import { jsonParse } from '../utils/telemetry/slowOperations.js'
import { selectEngine } from './bg/engines/index.js'
import type { SessionEntry } from './bg/engine.js'

/**
 * Terminate a background session and everything it spawned.
 *
 * On Windows the whole SIGTERM-then-SIGKILL ladder is a formality — both map to
 * TerminateProcess, so the session never runs its cleanup registry or saves its
 * transcript. What can be fixed is the orphaning: without a process group,
 * `process.kill` leaves the session's children (MCP servers, shells) running
 * forever. tree-kill uses `taskkill /T` to walk the tree.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    treeKill(pid, signal)
    return
  }
  process.kill(pid, signal)
}

export type { SessionEntry } from './bg/engine.js'

const sessionPidFiles = new WeakMap<SessionEntry, string>()

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

async function removeSessionArtifacts(
  pidFile: string,
  logPath?: string,
): Promise<void> {
  await Promise.all([
    unlink(pidFile).catch(() => {}),
    removeManagedSessionLog(logPath),
  ])
}

export async function listLiveSessions(): Promise<SessionEntry[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const sessions: SessionEntry[] = []
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    const pidFile = join(dir, file)
    const processRunning = isProcessRunning(pid)

    let entry: SessionEntry
    try {
      const raw = await readFile(pidFile, 'utf-8')
      entry = jsonParse(raw) as SessionEntry
    } catch {
      // Corrupt stale registries should not survive forever.
      if (!processRunning) await unlink(pidFile).catch(() => {})
      continue
    }

    if (!processRunning) {
      await removeSessionArtifacts(pidFile, entry.logPath)
      continue
    }

    // The filename is the registry authority. Trusting a divergent JSON PID
    // would let a stale or tampered entry redirect signal-sending commands.
    if (!Number.isSafeInteger(entry.pid) || entry.pid !== pid) {
      await removeSessionArtifacts(pidFile, entry.logPath)
      continue
    }

    if (entry.processStartMarker) {
      const currentMarker = await getProcessStartMarker(pid)
      if (currentMarker && currentMarker !== entry.processStartMarker) {
        if (getPlatform() !== 'wsl') {
          await removeSessionArtifacts(pidFile, entry.logPath)
        }
        continue
      }
    }

    sessionPidFiles.set(entry, pidFile)
    sessions.push(entry)
  }

  return sessions
}

export function findSession(
  sessions: SessionEntry[],
  target: string,
): SessionEntry | undefined {
  const asNum = parseInt(target, 10)
  return sessions.find(
    s =>
      s.sessionId === target ||
      s.pid === asNum ||
      (s.name && s.name === target),
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/**
 * Resolve the engine type for an existing session.
 * Backward-compatible: sessions without an `engine` field are inferred
 * from the presence of `tmuxSessionName`.
 */
function resolveSessionEngine(session: SessionEntry): 'tmux' | 'detached' {
  if (session.engine) return session.engine
  return session.tmuxSessionName ? 'tmux' : 'detached'
}

/**
 * `claude daemon status` / `claude ps` — list live sessions.
 */
export async function psHandler(_args: string[]): Promise<void> {
  const sessions = await listLiveSessions()

  if (sessions.length === 0) {
    console.log('No active sessions.')
    return
  }

  console.log(
    `${sessions.length} active session${sessions.length > 1 ? 's' : ''}:\n`,
  )

  for (const s of sessions) {
    const engineType = resolveSessionEngine(s)
    const parts: string[] = [
      `  PID: ${s.pid}`,
      `  Kind: ${s.kind}`,
      `  Engine: ${engineType}`,
      `  Session: ${s.sessionId}`,
      `  CWD: ${s.cwd}`,
    ]

    if (s.name) parts.push(`  Name: ${s.name}`)
    if (s.startedAt) parts.push(`  Started: ${formatTime(s.startedAt)}`)
    if (s.status) parts.push(`  Status: ${s.status}`)
    if (s.waitingFor) parts.push(`  Waiting for: ${s.waitingFor}`)
    if (s.bridgeSessionId) parts.push(`  Bridge: ${s.bridgeSessionId}`)
    if (s.tmuxSessionName) parts.push(`  Tmux: ${s.tmuxSessionName}`)
    if (s.logPath) parts.push(`  Log: ${s.logPath}`)

    console.log(parts.join('\n'))
    console.log()
  }
}

/**
 * `claude daemon logs <target>` — show logs for a session.
 */
export async function logsHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('No active sessions.')
      return
    }
    if (sessions.length === 1) {
      target = sessions[0]!.sessionId
    } else {
      console.log('Multiple sessions active. Specify one:')
      for (const s of sessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        console.log(`  ${label}  PID=${s.pid}`)
      }
      return
    }
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  if (!session.logPath) {
    console.log(`No log path recorded for session ${session.sessionId}`)
    return
  }

  try {
    const content = await readFile(session.logPath, 'utf-8')
    process.stdout.write(content)
  } catch (e) {
    console.error(`Failed to read log file: ${session.logPath}`)
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * `claude daemon attach <target>` — attach to a background session.
 *
 * Engine-aware: tmux sessions use tmux attach, detached sessions use log tail.
 */
export async function attachHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    // Find bg sessions (tmux or detached)
    const bgSessions = sessions.filter(
      s => s.tmuxSessionName || s.engine === 'detached',
    )
    if (bgSessions.length === 0) {
      console.log(
        `No background sessions to attach to. Start one with \`${BIN_NAME} daemon bg\`.`,
      )
      return
    }
    if (bgSessions.length === 1) {
      target = bgSessions[0]!.sessionId
    } else {
      console.log('Multiple background sessions. Specify one:')
      for (const s of bgSessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        const engineType = resolveSessionEngine(s)
        console.log(`  ${label}  PID=${s.pid}  engine=${engineType}`)
      }
      return
    }
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  const engineType = resolveSessionEngine(session)

  try {
    if (engineType === 'tmux') {
      const { TmuxEngine } = await import('./bg/engines/tmux.js')
      const tmux = new TmuxEngine()
      if (!(await tmux.available())) {
        console.error(
          'tmux is no longer available. Cannot attach to tmux session.',
        )
        process.exitCode = 1
        return
      }
      await tmux.attach(session)
    } else {
      const { DetachedEngine } = await import('./bg/engines/detached.js')
      const detached = new DetachedEngine()
      await detached.attach(session)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * `claude daemon kill <target>` — kill a session.
 */
export async function killHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('No active sessions to kill.')
      return
    }
    console.log('Specify a session to kill:')
    for (const s of sessions) {
      const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
      console.log(`  ${label}  PID=${s.pid}`)
    }
    return
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  if (!session.processStartMarker) {
    console.error(
      `Refusing to kill session ${session.sessionId}: its registry entry predates process identity checks.`,
    )
    console.error('Restart the session before using daemon kill.')
    process.exitCode = 1
    return
  }

  const currentMarker = await getProcessStartMarker(session.pid)
  if (!currentMarker) {
    console.error(
      `Refusing to kill session ${session.sessionId}: PID ${session.pid} could not be verified.`,
    )
    process.exitCode = 1
    return
  }
  if (currentMarker !== session.processStartMarker) {
    console.error(
      `Refusing to kill session ${session.sessionId}: PID ${session.pid} no longer matches the registered process.`,
    )
    process.exitCode = 1
    const pidFile = sessionPidFiles.get(session)
    if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
    return
  }

  console.log(`Killing session ${session.sessionId} (PID: ${session.pid})...`)

  try {
    // Windows has no process groups: process.kill reaches only the session
    // process itself, orphaning whatever it spawned. tree-kill shells out to
    // `taskkill /T` there. It is also unconditionally forceful — but SIGTERM on
    // Windows is already TerminateProcess, so no graceful shutdown is being
    // given up; see the note before the SIGKILL escalation below.
    killProcessTree(session.pid, 'SIGTERM')
  } catch {
    console.log('Session already exited.')
    const pidFile = sessionPidFiles.get(session)
    if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
    return
  }

  await new Promise(resolve => setTimeout(resolve, 2000))

  if (isProcessRunning(session.pid)) {
    const markerAfterGrace = await getProcessStartMarker(session.pid)
    if (!markerAfterGrace) {
      console.error(
        `Session ${session.sessionId} is still running, but its process identity could not be verified. Refusing to force-kill it.`,
      )
      process.exitCode = 1
      return
    }
    if (markerAfterGrace !== session.processStartMarker) {
      console.error(
        `PID ${session.pid} was reused during shutdown. Refusing to force-kill the replacement process.`,
      )
      process.exitCode = 1
      const pidFile = sessionPidFiles.get(session)
      if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
      return
    }

    try {
      killProcessTree(session.pid, 'SIGKILL')
      console.log('Session force-killed.')
    } catch {
      console.log('Session exited during grace period.')
    }
  } else {
    console.log('Session stopped.')
  }

  const pidFile = sessionPidFiles.get(session)
  if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
}

/**
 * `claude daemon bg [args]` — start a background session.
 *
 * Cross-platform: uses TmuxEngine on macOS/Linux when tmux is available,
 * falls back to DetachedEngine on Windows or when tmux is absent.
 */
export async function handleBgStart(args: string[]): Promise<void> {
  const engine = await selectEngine()

  // Strip --bg/--background from args (for backward-compat shortcut)
  const filteredArgs = args.filter(a => a !== '--bg' && a !== '--background')

  // Engines without interactive TTY input (e.g. detached) require -p/--print
  // or piped input. Tmux provides a virtual terminal so it works without -p.
  if (
    !engine.supportsInteractiveInput &&
    !filteredArgs.some(a => a === '-p' || a === '--print' || a === '--pipe')
  ) {
    console.error(
      'Error: Background sessions with detached engine require -p/--print flag.\n' +
        'The detached engine has no terminal for interactive input.\n\n' +
        'Usage:\n' +
        `  ${BIN_NAME} daemon bg -p "your prompt here"\n` +
        `  echo "prompt" | ${BIN_NAME} daemon bg --pipe`,
    )
    if (process.platform !== 'win32') {
      console.error(
        '\nAlternatively, install tmux for interactive background sessions:\n' +
          `  ${process.platform === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux'}`,
      )
    }
    process.exitCode = 1
    return
  }

  const sessionName = `${BIN_NAME}-bg-${randomUUID().slice(0, 8)}`
  const logPath = occConfigPath('sessions', 'logs', `${sessionName}.log`)

  try {
    const result = await engine.start({
      sessionName,
      args: filteredArgs,
      env: { ...process.env },
      logPath,
      cwd: process.cwd(),
    })

    console.log(`Background session started: ${result.sessionName}`)
    console.log(`  Engine: ${result.engineUsed}`)
    console.log(`  Log: ${result.logPath}`)
    console.log()
    console.log(
      `Use \`${BIN_NAME} daemon attach ${result.sessionName}\` to reconnect.`,
    )
    console.log(`Use \`${BIN_NAME} daemon status\` to check status.`)
    console.log(
      `Use \`${BIN_NAME} daemon kill ${result.sessionName}\` to stop.`,
    )
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
