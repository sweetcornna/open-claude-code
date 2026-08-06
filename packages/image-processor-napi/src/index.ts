import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharpModule from 'sharp'
import { spawnSync } from 'node:child_process'

export const sharp = sharpModule

interface NativeModule {
  hasClipboardImage(): boolean
  readClipboardImage(
    maxWidth?: number,
    maxHeight?: number,
  ): {
    png: Buffer
    width: number
    height: number
    originalWidth: number
    originalHeight: number
  } | null
}

/**
 * Run a command and capture stdout, on either runtime.
 *
 * These call sites used `Bun.spawnSync` directly. The published CLI's default
 * bin is `dist/cli-node.js` with a Node shebang — only `occ-bun` runs Bun — so
 * `Bun` was undefined and each of these threw `ReferenceError` inside a `catch`
 * that turned it into a silent "no clipboard image". This package cannot import
 * from `src/`, hence the local copy.
 */
function runCapture(cmd: string[]): {
  stdout: string
  exitCode: number | null
} {
  if (typeof Bun !== 'undefined' && typeof Bun.spawnSync === 'function') {
    const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' })
    return {
      stdout: new TextDecoder().decode(result.stdout),
      exitCode: result.exitCode,
    }
  }
  const [file, ...args] = cmd
  const result = spawnSync(file!, args, {
    encoding: 'utf8',
    windowsHide: true,
  })
  return { stdout: result.stdout ?? '', exitCode: result.status }
}

function createDarwinNativeModule(): NativeModule {
  return {
    hasClipboardImage(): boolean {
      try {
        const result = runCapture([
          'osascript',
          '-e',
          'try\nthe clipboard as «class PNGf»\nreturn "yes"\non error\nreturn "no"\nend try',
        ])
        const output = result.stdout.trim()
        return output === 'yes'
      } catch {
        return false
      }
    },

    readClipboardImage(maxWidth?: number, maxHeight?: number) {
      // Use osascript to read clipboard image as PNG data and write to a temp file,
      // then read the temp file back.
      const tmpPath = join(tmpdir(), `occ-clipboard-native-${randomUUID()}.png`)
      try {
        const script = `
set png_data to (the clipboard as «class PNGf»)
set fp to open for access POSIX file "${tmpPath}" with write permission
write png_data to fp
close access fp
return "${tmpPath}"
`
        const result = runCapture(['osascript', '-e', script])

        if (result.exitCode !== 0) {
          return null
        }

        const buffer: Buffer = readFileSync(tmpPath)

        if (buffer.length === 0) {
          return null
        }

        // Read PNG dimensions from IHDR chunk
        // PNG header: 8 bytes signature, then IHDR chunk
        // IHDR starts at offset 8 (4 bytes length) + 4 bytes "IHDR" + 4 bytes width + 4 bytes height
        let width = 0
        let height = 0
        if (
          buffer.length > 24 &&
          buffer[12] === 0x49 &&
          buffer[13] === 0x48 &&
          buffer[14] === 0x44 &&
          buffer[15] === 0x52
        ) {
          width = buffer.readUInt32BE(16)
          height = buffer.readUInt32BE(20)
        }

        const originalWidth = width
        const originalHeight = height

        // If maxWidth/maxHeight are specified and the image exceeds them,
        // we still return the full PNG - the caller handles resizing via sharp
        // But we report the capped dimensions
        if (maxWidth && maxHeight) {
          if (width > maxWidth || height > maxHeight) {
            const scale = Math.min(maxWidth / width, maxHeight / height)
            width = Math.round(width * scale)
            height = Math.round(height * scale)
          }
        }

        return {
          png: buffer,
          width,
          height,
          originalWidth,
          originalHeight,
        }
      } catch {
        return null
      } finally {
        try {
          unlinkSync(tmpPath)
        } catch {
          // ignore cleanup errors
        }
      }
    },
  }
}

export function getNativeModule(): NativeModule | null {
  if (process.platform === 'darwin') {
    return createDarwinNativeModule()
  }
  return null
}

export default sharp
