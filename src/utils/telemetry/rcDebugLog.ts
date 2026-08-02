/**
 * File-based debug logger for Remote Control bridge diagnostics.
 * Writes [RC-DEBUG] lines to <configDir>/rc-debug.log so they survive
 * Ink's stdout capture in the REPL / bridge UI.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'

// Lazy: occConfigDir() reads process.env, and entrypoints may set
// OCC_CONFIG_DIR inside main() after this module is evaluated.
function logPath(): string {
  return occConfigPath('rc-debug.log')
}

function ensureLogDir() {
  const dir = occConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

let headerWritten = false

export function rcLog(msg: string): void {
  try {
    if (!headerWritten) {
      ensureLogDir()
      appendFileSync(
        logPath(),
        `\n===== RC-DEBUG session ${new Date().toISOString()} =====\n`,
      )
      headerWritten = true
    }
    const ts = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
    appendFileSync(logPath(), `[${ts}] ${msg}\n`)
  } catch {
    // best-effort — never crash the bridge
  }
}

/** Clear the log file at session start. */
export function rcLogClear(): void {
  try {
    ensureLogDir()
    appendFileSync(logPath(), '')
  } catch {}
}
