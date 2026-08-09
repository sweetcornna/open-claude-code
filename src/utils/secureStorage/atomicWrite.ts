import { randomUUID } from 'crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { open, rename, rm } from 'fs/promises'

const PRIVATE_FILE_MODE = 0o600

/**
 * Replace a credential file without ever truncating the previous valid copy.
 *
 * The temporary file lives beside the target so rename is atomic. Syncing it
 * before rename prevents a successful return from referring only to buffered
 * data; a crash before rename leaves the old credential file intact.
 */
export function writePrivateFileAtomicSync(
  filePath: string,
  content: string,
): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined

  try {
    fd = openSync(tempPath, 'wx', PRIVATE_FILE_MODE)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, filePath)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Cleanup must not replace the original write failure.
      }
    }
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // Cleanup must not replace the original write failure.
    }
    throw error
  }
}

export async function writePrivateFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined

  try {
    handle = await open(tempPath, 'wx', PRIVATE_FILE_MODE)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    // The temporary file was created 0600, and rename preserves that mode. Do
    // not add a fallible post-rename chmod: after replacement there is no way to
    // report failure while also preserving the previous credential.
    await rename(tempPath, filePath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
