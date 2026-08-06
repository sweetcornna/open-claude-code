/**
 * Runtime-agnostic process helpers for the Computer Use backends.
 *
 * These backends called `Bun.spawnSync` / `Bun.spawn` directly. The published
 * CLI's default bin is `dist/cli-node.js` with a Node shebang — only `occ-bun`
 * runs Bun — so `Bun` was undefined and every call threw `ReferenceError`,
 * usually inside a `catch` that reported it as "backend unavailable".
 *
 * Bun stays the preferred branch where it exists. This package cannot import
 * from the app's `src/`, hence the local copy.
 */
import { spawn, spawnSync } from 'node:child_process'

export function runCaptureSync(cmd: string[]): {
  stdout: string
  stderr: string
  exitCode: number | null
} {
  if (typeof Bun !== 'undefined' && typeof Bun.spawnSync === 'function') {
    const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' })
    const decoder = new TextDecoder()
    return {
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
      exitCode: result.exitCode,
    }
  }
  const [file, ...args] = cmd
  const result = spawnSync(file!, args, {
    encoding: 'utf8',
    windowsHide: true,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  }
}

export async function runCapture(cmd: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
}> {
  if (typeof Bun !== 'undefined' && typeof Bun.spawn === 'function') {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  }
  const [file, ...args] = cmd
  return new Promise(resolve => {
    const child = spawn(file!, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', c => {
      stdout += c
    })
    child.stderr?.on('data', c => {
      stderr += c
    })
    child.on('error', e =>
      resolve({ stdout, stderr: e.message, exitCode: null }),
    )
    child.on('close', code => resolve({ stdout, stderr, exitCode: code }))
  })
}
