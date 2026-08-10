import { feature } from 'bun:bundle'
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { BIN_NAME, occConfigPath } from '../../config/paths.js'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../../bootstrap/state.js'
import { registerCleanup } from '../process/cleanupRegistry.js'
import { logForDebugging } from '../telemetry/debug.js'
import { getClaudeConfigHomeDir } from '../config/envUtils.js'
import { errorMessage, isFsInaccessible } from '../runtime/errors.js'
import { isProcessRunning } from '../process/genericProcessUtils.js'
import { getPlatform } from '../process/platform.js'
import { jsonParse, jsonStringify } from '../telemetry/slowOperations.js'
import { getAgentId } from '../agents/teammate.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

export type PeerSession = {
  pid: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  kind?: SessionKind
  name?: string
  entrypoint?: string
  bridgeSessionId?: string | null
  alive: boolean
}

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

/**
 * Delete only logs created by the background-session launcher. Registry files
 * are user-writable input, so a recorded path must never be passed directly to
 * unlink: it must resolve to a direct child of the managed log directory and
 * match the launcher's filename format.
 */
export async function removeManagedSessionLog(
  logPath: string | undefined,
): Promise<void> {
  if (!logPath) return

  const logsDir = resolve(occConfigPath('sessions', 'logs'))
  const target = resolve(logPath)
  const prefix = `${BIN_NAME}-bg-`
  const filename = basename(target)
  if (
    dirname(target) !== logsDir ||
    !filename.startsWith(prefix) ||
    !/^[0-9a-f]{8}\.log$/i.test(filename.slice(prefix.length))
  ) {
    return
  }

  await unlink(target).catch(() => {})
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

/**
 * Return an OS-derived marker that changes when a PID is reused.
 * A missing marker must be treated as unverifiable by signal-sending callers.
 */
/**
 * Run a command and capture stdout, on either runtime.
 *
 * This used to be a bare `Bun.spawn`. `bin.occ` is `dist/cli-node.js` with a
 * Node shebang, so Bun is undefined on the default runtime and the call threw
 * `ReferenceError` — swallowed by the caller's catch, which returned undefined,
 * which `occ bg kill` reads as "PID could not be verified" and refuses to act.
 * Linux survived on the `/proc` fast path above; Windows had no fallback, so
 * the kill path was simply dead there.
 *
 * Bun stays the preferred branch (same shape as `which.ts`): it avoids the
 * child_process module entirely, which keeps this off the process-global
 * `mock.module` registry that test files install for unrelated suites.
 */
async function captureCommand(
  command: string[],
): Promise<{ stdout: string; exitCode: number | null }> {
  const env = { ...process.env, LC_ALL: 'C' }
  if (typeof Bun !== 'undefined' && typeof Bun.spawn === 'function') {
    const child = Bun.spawn(command, {
      stdout: 'pipe',
      stderr: 'ignore',
      env,
    })
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ])
    return { stdout, exitCode }
  }
  const { execFile } = await import('child_process')
  const [file, ...args] = command
  return new Promise(resolve => {
    execFile(
      file!,
      args,
      { env, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        resolve({ stdout: stdout ?? '', exitCode: error ? 1 : 0 })
      },
    )
  })
}

export async function getProcessStartMarker(
  pid: number,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined

  const platform = getPlatform()
  if (platform === 'linux' || platform === 'wsl') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = stat.lastIndexOf(')')
      if (commandEnd !== -1) {
        // After the command name, index 0 is field 3 (state); field 22 is the
        // kernel start tick and remains stable for the lifetime of the process.
        const startTick = stat
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/)[19]
        if (startTick && /^\d+$/.test(startTick)) return `proc:${startTick}`
      }
    } catch {
      // Fall through to the platform process query below.
    }
  }

  const command =
    platform === 'windows'
      ? [
          'powershell.exe',
          '-NoProfile',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CreationDate.ToUniversalTime().ToFileTimeUtc() }`,
        ]
      : ['ps', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)]

  try {
    const { stdout, exitCode } = await captureCommand(command)
    const rawMarker = exitCode === 0 ? stdout.trim() : ''
    return rawMarker ? `${platform}:${rawMarker}` : undefined
  } catch {
    return pid === process.pid
      ? `epoch:${Math.floor(performance.timeOrigin / 1000)}`
      : undefined
  }
}

export function getBgSessionMetadata(): {
  name?: string
  logPath?: string
  agent?: string
  engine?: 'tmux' | 'detached'
  tmuxSessionName?: string
} {
  const engine = process.env.CLAUDE_CODE_SESSION_ENGINE
  return {
    name: process.env.CLAUDE_CODE_SESSION_NAME,
    logPath: process.env.CLAUDE_CODE_SESSION_LOG,
    agent: process.env.CLAUDE_CODE_AGENT,
    engine: engine === 'tmux' || engine === 'detached' ? engine : undefined,
    tmuxSessionName: process.env.CLAUDE_CODE_TMUX_SESSION,
  }
}

/**
 * Kind override from env. Set by the spawner (`claude --bg`, daemon
 * supervisor) so the child can register without the parent having to
 * write the file for it — cleanup-on-exit wiring then works for free.
 * Gated so the env-var string is DCE'd from external builds.
 */
function envSessionKind(): SessionKind | undefined {
  if (feature('BG_SESSIONS')) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

/**
 * True when this REPL is running inside a `claude --bg` tmux session.
 * Exit paths (/exit, ctrl+c, ctrl+d) should detach the attached client
 * instead of killing the process.
 */
export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * Write a PID file for this session and register cleanup.
 *
 * Registers all top-level sessions — interactive CLI, SDK (vscode, desktop,
 * typescript, python, -p), bg/daemon spawns — so `claude ps` sees everything
 * the user might be running. Skips only teammates/subagents, which would
 * conflate swarm usage with genuine concurrency and pollute ps with noise.
 *
 * Returns true if registered, false if skipped.
 * Errors logged to debug, never thrown.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)
  const processStartMarker = await getProcessStartMarker(process.pid)
  const logPath =
    process.env.CLAUDE_CODE_SESSION_KIND === 'bg'
      ? getBgSessionMetadata().logPath
      : undefined

  registerCleanup(async () => {
    await removeSessionArtifacts(pidFile, logPath)
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await writeFile(
      pidFile,
      jsonStringify({
        pid: process.pid,
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        startedAt: Date.now(),
        kind,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
        processStartMarker,
        ...(feature('BG_SESSIONS') ? getBgSessionMetadata() : {}),
      }),
    )
    // --resume / /resume mutates getSessionId() via switchSession. Without
    // this, the PID file's sessionId goes stale and `claude ps` sparkline
    // reads the wrong transcript.
    onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (e) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    return false
  }
}

/**
 * Update this session's name in its PID registry file so ListPeers
 * can surface it. Best-effort: silently no-op if name is falsy, the
 * file doesn't exist (session not registered), or read/write fails.
 */
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(pidFile, jsonStringify({ ...data, ...patch }))
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`,
    )
  }
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

/**
 * Record this session's Remote Control session ID so peer enumeration can
 * dedup: a session reachable over both UDS and bridge should only appear
 * once (local wins). Cleared on bridge teardown so stale IDs don't
 * suppress a legitimately-remote session after reconnect.
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

/**
 * Push live activity state for `claude ps`. Fire-and-forget from REPL's
 * status-change effect — a dropped write just means ps falls back to
 * transcript-tail derivation for one refresh.
 */
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!feature('BG_SESSIONS')) return
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * Count live concurrent CLI sessions (including this one).
 * Filters out stale PID files (crashed sessions) and deletes them.
 * Returns 0 on any error (conservative).
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    // Strict filename guard: only `<pid>.json` is a candidate. parseInt's
    // lenient prefix-parsing means `2026-03-14_notes.md` would otherwise
    // parse as PID 2026 and get swept as stale — silent user data loss.
    // See anthropics/claude-code#34210.
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // Stale file from a crashed session — sweep it. Skip on WSL: if
      // ~/.claude/sessions/ is shared with Windows-native Claude (symlink
      // or CLAUDE_CONFIG_DIR), a Windows PID won't be probeable from WSL
      // and we'd falsely delete a live session's file. This is just
      // telemetry so conservative undercount is acceptable.
      const pidFile = join(dir, file)
      let logPath: string | undefined
      try {
        const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<
          string,
          unknown
        >
        if (typeof data.logPath === 'string') logPath = data.logPath
      } catch {
        // Corrupt stale registries still need their PID file removed.
      }
      await removeSessionArtifacts(pidFile, logPath)
    }
  }
  return count
}

/**
 * List all live sessions from the PID registry. Sessions whose PID is no
 * longer running are excluded (concurrentSessions handles cleanup).
 */
export async function listAllLiveSessions(): Promise<PeerSession[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return []
  }

  const results: PeerSession[] = []

  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)

    if (!isProcessRunning(pid)) {
      // Stale — skip (concurrentSessions handles cleanup)
      continue
    }

    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const data = jsonParse(raw) as Record<string, unknown>
      results.push({
        pid,
        sessionId: data.sessionId as string | undefined,
        cwd: data.cwd as string | undefined,
        startedAt: data.startedAt as number | undefined,
        kind: data.kind as SessionKind | undefined,
        name: data.name as string | undefined,
        entrypoint: data.entrypoint as string | undefined,
        bridgeSessionId: data.bridgeSessionId as string | null | undefined,
        alive: true,
      })
    } catch {
      // Corrupted file — skip
    }
  }

  return results
}
