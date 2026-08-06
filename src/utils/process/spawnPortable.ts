/**
 * Runtime-agnostic process spawning.
 *
 * `Bun.spawn` only exists under Bun, and `bin.occ` is `dist/cli-node.js` with a
 * Node shebang — Node is the default runtime, and only `occ-bun` runs Bun. Code
 * that reached for `Bun.spawn` without a guard therefore threw `ReferenceError`
 * for most users, usually inside a `catch` that turned the crash into a silent
 * "feature unavailable".
 *
 * Bun stays the preferred branch where it exists: it avoids the child_process
 * module entirely, which keeps these calls off the process-global
 * `mock.module` registry that test files install for unrelated suites.
 *
 * Zero dependencies beyond node:child_process so any layer can import it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { Readable, type Readable as NodeReadable } from 'node:stream'

/**
 * The subset of Bun's `Subprocess` that long-lived callers here actually use.
 *
 * Deliberately narrow: it is a contract two backends have to satisfy, and every
 * member added is another thing that can differ between them.
 */
export type StreamingProcess = {
  /** Resolves with the exit code, or null if the child was killed by a signal. */
  exited: Promise<number | null>
  /** Exit code once the child has exited; null before that, or if signalled. */
  readonly exitCode: number | null
  /** Signal name if the child was killed by one; null otherwise. */
  readonly signalCode: NodeJS.Signals | null
  kill(): void
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  stdin: { write(chunk: string | Uint8Array): void; end(): void } | null
}

export type CaptureResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  /** True when `timeoutMs` elapsed and the child was killed. */
  timedOut: boolean
}

export type CaptureOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Text written to the child's stdin, which is then closed. */
  input?: string
  /**
   * Kill the child after this many milliseconds and return what it produced so
   * far with `timedOut: true`. Callers that talk to the network need this —
   * an unreachable SSH host otherwise hangs the caller indefinitely.
   */
  timeoutMs?: number
}

/**
 * Run a command to completion and collect its output.
 *
 * Never rejects on a non-zero exit — callers branch on `exitCode`. A spawn
 * failure (ENOENT and friends) surfaces the same way, as a null exit code with
 * the reason on stderr, so a missing binary and a failing one are handled by
 * the same code path.
 */
export async function captureProcess(
  command: string[],
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const [file, ...args] = command
  if (!file) {
    return {
      stdout: '',
      stderr: 'empty command',
      exitCode: null,
      timedOut: false,
    }
  }

  if (typeof Bun !== 'undefined' && typeof Bun.spawn === 'function') {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin:
        options.input === undefined
          ? 'ignore'
          : new TextEncoder().encode(options.input),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let timedOut = false
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            proc.kill()
          }, options.timeoutMs)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode, timedOut }
    } finally {
      clearTimeout(timer)
    }
  }

  return new Promise<CaptureResult>(resolve => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill()
          }, options.timeoutMs)
    const finish = (exitCode: number | null, extraStderr = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr: `${stderr}${extraStderr}`, exitCode, timedOut })
    }
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => finish(null, error.message))
    child.on('close', code => finish(code))
    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

/**
 * Spawn a long-lived child with piped stdio, on either runtime.
 *
 * Returns the narrow {@link StreamingProcess} shape rather than Bun's
 * `Subprocess`, so callers cannot accidentally depend on a member that only
 * one backend has.
 */
export function spawnStreaming(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): StreamingProcess {
  const [file, ...args] = command
  if (!file) {
    throw new Error('spawnStreaming requires a command')
  }

  if (typeof Bun !== 'undefined' && typeof Bun.spawn === 'function') {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const sink = proc.stdin
    return {
      exited: proc.exited,
      get exitCode() {
        return proc.exitCode
      },
      get signalCode() {
        return proc.signalCode as NodeJS.Signals | null
      },
      kill: () => proc.kill(),
      stdout: proc.stdout as ReadableStream<Uint8Array> | null,
      stderr: proc.stderr as ReadableStream<Uint8Array> | null,
      stdin: sink
        ? {
            write: chunk => {
              sink.write(chunk)
              sink.flush()
            },
            end: () => void sink.end(),
          }
        : null,
    }
  }

  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = new Promise<number | null>(resolve => {
    child.on('close', code => resolve(code))
    // A spawn failure never emits 'close'; report it as a non-zero exit so
    // callers do not hang waiting on a process that never started.
    child.on('error', () => resolve(null))
  })
  return {
    exited,
    get exitCode() {
      return child.exitCode
    },
    get signalCode() {
      return child.signalCode
    },
    kill: () => void child.kill(),
    stdout: child.stdout ? toWebStream(child.stdout) : null,
    stderr: child.stderr ? toWebStream(child.stderr) : null,
    stdin: child.stdin
      ? {
          write: chunk => void child.stdin!.write(chunk),
          end: () => void child.stdin!.end(),
        }
      : null,
  }
}

function toWebStream(readable: NodeReadable): ReadableStream<Uint8Array> {
  // Node types Readable.toWeb() as ReadableStream<any>; the chunks are Buffers,
  // which are Uint8Arrays. Through unknown because the two ReadableStream
  // declarations (DOM lib and node:stream/web) do not structurally overlap.
  return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>
}

export type CaptureSyncResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * Synchronous {@link captureProcess}.
 *
 * Only for callers that genuinely cannot await — the Computer Use backends
 * query window state from synchronous accessors. Everything else should use the
 * async form; this blocks the event loop for the duration of the child.
 */
export function captureProcessSync(
  command: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    /** Text written to the child's stdin, which is then closed. */
    input?: string
  } = {},
): CaptureSyncResult {
  const [file, ...args] = command
  if (!file) {
    return { stdout: '', stderr: 'empty command', exitCode: null }
  }

  if (typeof Bun !== 'undefined' && typeof Bun.spawnSync === 'function') {
    const result = Bun.spawnSync({
      cmd: command,
      cwd: options.cwd,
      env: options.env,
      stdin:
        options.input === undefined
          ? undefined
          : new TextEncoder().encode(options.input),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: options.timeoutMs,
    })
    const decoder = new TextDecoder()
    return {
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
      exitCode: result.exitCode,
    }
  }

  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
    exitCode: result.status,
  }
}
