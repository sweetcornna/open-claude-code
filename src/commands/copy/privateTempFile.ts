import { rmSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIN_NAME } from 'src/config/paths.js'
import { RM_RECURSIVE } from '../../utils/filesystem/rmOptions.js'

const copyTempDirs = new Set<string>()
let cleanupRegistered = false

export function cleanupCopyTempDirs(): void {
  for (const dir of copyTempDirs) {
    rmSync(dir, RM_RECURSIVE)
  }
  copyTempDirs.clear()
}

function registerCopyTempCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  // The fallback file must remain usable during the session, but model output
  // must not survive after the CLI process has finished with it.
  process.once('exit', cleanupCopyTempDirs)
}

export async function writeToPrivateTempFile(
  text: string,
  filename: string,
): Promise<string> {
  const copyDir = await mkdtemp(join(tmpdir(), `${BIN_NAME}-copy-`))
  copyTempDirs.add(copyDir)
  registerCopyTempCleanup()
  try {
    await chmod(copyDir, 0o700)
    const filePath = join(copyDir, filename)
    await writeFile(filePath, text, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    })
    return filePath
  } catch (error) {
    copyTempDirs.delete(copyDir)
    await rm(copyDir, RM_RECURSIVE)
    throw error
  }
}
