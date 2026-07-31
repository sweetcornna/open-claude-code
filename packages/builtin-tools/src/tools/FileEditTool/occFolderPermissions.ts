/**
 * Permission-rule patterns for the occ config folders.
 *
 * Split out of constants.ts so that file can stay a pure leaf: these patterns
 * must be derived from src/config/paths.ts (the single source of truth for the
 * occ/official-Claude-Code isolation), which is exactly the kind of `src/`
 * import a constants leaf may not have.
 */
import { occConfigDir, PROJECT_DIR_NAME } from 'src/config/paths.js'

export const OCC_FOLDER_PERMISSION_PATTERN = `/${PROJECT_DIR_NAME}/**`

export function getGlobalOccFolderPermissionPattern(): string {
  let normalized = occConfigDir().replaceAll('\\', '/')
  const drive = normalized.match(/^([a-z]):\/(.*)$/i)
  if (drive) {
    normalized = `${drive[1]?.toLowerCase()}/${drive[2]}`
  } else {
    normalized = normalized.replace(/^\/+/, '')
  }
  return `//${normalized}/**`
}
