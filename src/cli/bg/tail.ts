import {
  openSync,
  readSync,
  closeSync,
  statSync,
  watchFile,
  unwatchFile,
  createReadStream,
} from 'fs'
import { createInterface } from 'readline'

/**
 * Cross-platform real-time log output. Ctrl+C exits tail without killing
 * the background process.
 *
 * Strategy:
 *  1. Read existing content and output to stdout
 *  2. Use fs.watchFile() (polling-based — works everywhere including Windows)
 *  3. On change, read new bytes from the last known position
 *  4. SIGINT exits cleanly
 */
export async function tailLog(logPath: string): Promise<void> {
  let position = 0
  let fileIdentity: string | null = null

  // Output existing content
  try {
    const stat = statSync(logPath)
    fileIdentity = `${stat.dev}:${stat.ino}`
    position = stat.size
    if (position > 0) {
      const stream = createReadStream(logPath, { start: 0, end: position - 1 })
      const rl = createInterface({ input: stream })
      for await (const line of rl) {
        process.stdout.write(line + '\n')
      }
    }
  } catch {
    // File may not exist yet — that's fine
  }

  console.log('\n[tail] Watching for new output... (Ctrl+C to detach)\n')

  return new Promise<void>(resolve => {
    const onSignal = (): void => {
      unwatchFile(logPath)
      process.removeListener('SIGINT', onSignal)
      console.log('\n[tail] Detached from session.')
      resolve()
    }
    process.on('SIGINT', onSignal)

    watchFile(logPath, { interval: 300 }, () => {
      try {
        const stat = statSync(logPath)
        const nextIdentity = `${stat.dev}:${stat.ino}`
        if (fileIdentity !== null && nextIdentity !== fileIdentity) {
          position = 0
        } else if (stat.size < position) {
          position = 0
        }
        fileIdentity = nextIdentity
        if (stat.size <= position) return

        const fd = openSync(logPath, 'r')
        try {
          const buf = Buffer.alloc(stat.size - position)
          readSync(fd, buf, 0, buf.length, position)
          process.stdout.write(buf)
          position = stat.size
        } finally {
          closeSync(fd)
        }
      } catch {
        // A delete followed by recreate must resume from the new file's start.
        position = 0
        fileIdentity = null
      }
    })
  })
}
