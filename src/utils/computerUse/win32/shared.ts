/**
 * Shared utilities for win32 Computer Use modules.
 * Single source of truth — no more duplication across files.
 */
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Validate HWND is a pure numeric string — prevents PowerShell/Python injection. */
export function validateHwnd(hwnd: string): string {
  if (!/^\d+$/.test(hwnd)) {
    throw new Error(`Invalid HWND: "${hwnd}" — must be numeric`)
  }
  return hwnd
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command']

/**
 * These used to call `Bun.spawnSync` / `Bun.spawn`. `bin.occ` is
 * `dist/cli-node.js` with a Node shebang — Node is the default runtime, and
 * only `occ-bun` runs Bun — so `Bun` was undefined and every one of these threw
 * `ReferenceError` on the platform they exist to serve. `ps()` had no try/catch
 * at all, so it took the caller down with it.
 *
 * child_process works under both runtimes. `windowsHide` keeps the PowerShell
 * console from flashing over the TUI.
 */
function runPowerShell(script: string): {
  stdout: string
  status: number | null
} {
  const result = spawnSync('powershell', [...PS_ARGS, script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return { stdout: (result.stdout ?? '').trim(), status: result.status }
}

/** Run a PowerShell script synchronously, return stdout trimmed. */
export function ps(script: string): string {
  return runPowerShell(script).stdout
}

/** Full result for callers that need stderr or the exit code. */
export function psResult(script: string): {
  stdout: string
  stderr: string
  exitCode: number | null
} {
  const result = spawnSync('powershell', [...PS_ARGS, script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    exitCode: result.status,
  }
}

/** Run a PowerShell script synchronously, return null on failure. */
export function runPs(script: string): string | null {
  try {
    const { stdout, status } = runPowerShell(script)
    return status === 0 ? stdout : null
  } catch {
    return null
  }
}

/** Run a PowerShell script asynchronously. */
export async function psAsync(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell', [...PS_ARGS, script], {
    windowsHide: true,
  })
  return stdout.trim()
}

/** Get the system temp directory. */
export function getTmpDir(): string {
  return process.env.TEMP || process.env.TMP || '/tmp'
}

/** Virtual key code mapping — canonical, complete. */
export const VK_MAP: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  lshift: 0xa0,
  rshift: 0xa1,
  ctrl: 0x11,
  control: 0x11,
  lcontrol: 0xa2,
  rcontrol: 0xa3,
  alt: 0x12,
  option: 0x12,
  menu: 0x12,
  lalt: 0xa4,
  ralt: 0xa5,
  pause: 0x13,
  capslock: 0x14,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  win: 0x5b,
  meta: 0x5b,
  command: 0x5b,
  cmd: 0x5b,
  super: 0x5b,
  numlock: 0x90,
  scrolllock: 0x91,
  printscreen: 0x2c,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
}

export const MODIFIER_KEYS = new Set([
  'shift',
  'lshift',
  'rshift',
  'control',
  'ctrl',
  'lcontrol',
  'rcontrol',
  'alt',
  'option',
  'lalt',
  'ralt',
  'win',
  'meta',
  'command',
  'cmd',
  'super',
])
