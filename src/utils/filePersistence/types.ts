export const FILE_COUNT_LIMIT = 10000
export const OUTPUTS_SUBDIR = ".claude-code/outputs"
export const DEFAULT_UPLOAD_CONCURRENCY = 5

export interface FailedPersistence {
  filePath: string
  error: string
}

export interface PersistedFile {
  filePath: string
  fileId: string
}

export interface FilesPersistedEventData {
  sessionId: string
  turnStartTime: number
  persistedFiles: PersistedFile[]
  failedFiles: FailedPersistence[]
}

export interface TurnStartTime {
  turnStartTime: number
}
