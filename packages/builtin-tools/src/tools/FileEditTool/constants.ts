import { occConfigDir, PROJECT_DIR_NAME } from 'src/config/paths.js'

export const FILE_EDIT_TOOL_NAME = 'Edit'

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

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
